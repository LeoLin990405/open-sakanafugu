import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join as joinPath } from 'node:path';
import type { Dirent } from 'node:fs';
import type { Readable } from 'node:stream';

import { Command, Option } from 'clipanion';

import { FsExperienceStore } from '../../adapters/experience/fs-experience-store.js';
import { CodexHarness } from '../../adapters/harness/codex-harness.js';
import { FugueCcHarness } from '../../adapters/harness/fugue-cc-harness.js';
import { OpencodeHarness } from '../../adapters/harness/opencode-harness.js';
import { classifyType, parseDescription } from '../../domain/skill-parse.js';
import type { SkillRef, SkillSourceKind, SkillType } from '../../domain/skill.js';
import { DEFAULT_NOTE_RE } from '../../domain/skill.js';
import { HARNESS_NAMES, type Harness, type HarnessName } from '../../domain/ports/harness.js';
import { isOk } from '../../domain/result.js';
import { systemClock } from '../../infra/clock.js';
import { NodeCommandRunner } from '../../infra/node-command-runner.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';

const stateDir = (): string =>
  process.env.FUGUE_STATE ?? joinPath(joinPath(homedir(), '.config'), 'fugue');

const rootDir = (): string =>
  process.env.FUGUE_SKILLS_ROOT ?? joinPath(joinPath(homedir(), '.claude'), 'skills');

const pluginsDir = (): string =>
  process.env.FUGUE_PLUGINS_ROOT ??
  joinPath(joinPath(joinPath(homedir(), '.claude'), 'plugins'), 'marketplaces');

const catalogPath = (): string =>
  process.env.FUGUE_SKILLS_CATALOG ?? joinPath(stateDir(), 'skills-catalog.tsv');

const experienceRoot = (): string =>
  process.env.FUGUE_EXPERIENCE ?? joinPath(stateDir(), 'experience');

const noteRe = (): RegExp => {
  const raw = process.env.FUGUE_SKILLS_NOTE_RE;
  if (raw === undefined || raw.length === 0) return DEFAULT_NOTE_RE;
  return new RegExp(raw, 'u');
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
};

const splitCsv = (raw: string): readonly string[] =>
  raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const parseCatalog = (content: string): readonly SkillRef[] => {
  const refs: SkillRef[] = [];
  for (const line of content.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const [id, source, type, path, description = ''] = line.split('\t');
    if (
      id === undefined ||
      source === undefined ||
      type === undefined ||
      path === undefined ||
      !isSource(source) ||
      !isType(type)
    ) {
      continue;
    }
    refs.push({ id, source, type, path, description });
  }
  return refs;
};

const renderCatalog = (refs: readonly SkillRef[]): string =>
  refs
    .map((ref) => `${ref.id}\t${ref.source}\t${ref.type}\t${ref.path}\t${ref.description}`)
    .join('\n') + (refs.length > 0 ? '\n' : '');

const isSource = (value: string): value is SkillSourceKind =>
  value === 'user' || value === 'system' || value === 'plugin';

const isType = (value: string): value is SkillType => value === 'functional' || value === 'note';

const isHarnessName = (value: string): value is HarnessName =>
  (HARNESS_NAMES as readonly string[]).includes(value);

const pluginId = (skillMdPath: string): string => {
  const parts = skillMdPath.split('/');
  let plug = '';
  let skill = '';
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === 'plugins') plug = parts[index + 1] ?? '';
    if (parts[index] === 'skills') skill = parts[index + 1] ?? '';
  }
  return plug.length > 0 && skill.length > 0 ? `${plug}:${skill}` : basename(dirname(skillMdPath));
};

const readStdin = async (stdin: Readable): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    let data = '';
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk: string) => {
      data += chunk;
    });
    stdin.on('end', () => resolve(data));
    stdin.on('error', reject);
  });

const frontmatterLines = (content: string): readonly string[] => {
  const lines = content.split(/\r?\n/u);
  if (lines[0] !== '---') return [];
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  return end === -1 ? [] : lines.slice(1, end);
};

const field = (content: string, key: string): string => {
  const prefix = `${key}:`;
  for (const line of frontmatterLines(content)) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return '';
};

const parseDescriptionRaw = (content: string): string => {
  const lines = content.split(/\r?\n/u);
  let inFront = false;
  let frontDelims = 0;
  let inDesc = false;
  let desc = '';
  for (const line of lines) {
    if (/^---[ \t]*$/u.test(line)) {
      frontDelims += 1;
      inFront = frontDelims < 2;
      continue;
    }
    if (inFront && /^description:/u.test(line)) {
      const value = line.replace(/^description:[ \t]*/u, '');
      if (/^[>|]/u.test(value) || value === '') {
        desc = '';
        inDesc = true;
      } else {
        desc = value;
        inDesc = false;
      }
      continue;
    }
    if (inFront && inDesc && /^[ \t]/u.test(line)) {
      const value = line.replace(/^[ \t]+/u, '');
      desc = desc.length === 0 ? value : `${desc} ${value}`;
      continue;
    }
    if (inFront && /^[A-Za-z_]+:/u.test(line)) inDesc = false;
  }
  return desc.replace(/^[ \t]+|[ \t]+$/gu, '').replace(/[ \t]+/gu, ' ');
};

export class SkillsCommand extends Command {
  static override paths = [['skills']];

  args = Option.Proxy();

  private readonly fs = new NodeFileSystem();

  override async execute(): Promise<number> {
    const [sub, ...rest] = this.args;
    try {
      switch (sub) {
        case 'index':
          return await this.index(rest);
        case 'list':
          return await this.list(rest);
        case 'match':
          return await this.match(rest);
        case 'show':
          return await this.show(rest);
        case 'inject':
          return await this.inject(rest);
        case 'validate':
          return await this.validate(rest);
        case 'forge':
          return await this.forge(rest);
        case undefined:
        case '-h':
        case '--help':
          return this.renderSkillsHelp();
        default:
          return this.error(
            `unknown subcommand '${sub}' (index|list|match|show|inject|validate|forge)`,
          );
      }
    } catch (error) {
      return this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private renderSkillsHelp(): number {
    this.context.stdout.write(
      [
        'fugue skills index|list|match|show|inject|validate|forge',
        'fugue skills index [--refresh]',
        'fugue skills inject <id1,id2,...> [--full]',
        '',
      ].join('\n'),
    );
    return 0;
  }

  private async index(args: readonly string[], quiet = false): Promise<number> {
    const refresh = args[0] === '--refresh';
    const root = rootDir();
    const catalog = catalogPath();
    if (!(await exists(root))) return this.error(`no skills root: ${root}`);
    const current = await this.fs.read(catalog);
    if (!refresh && current !== null && current.trim().length > 0) {
      if (!quiet)
        this.context.stdout.write(
          `✓ catalog already exists: ${catalog} (${String(
            parseCatalog(current).length,
          )} entries; --refresh rebuilds)\n`,
        );
      return 0;
    }

    const refs = await this.scan();
    await this.fs.write(catalog, renderCatalog(refs));
    if (quiet) return 0;
    this.context.stdout.write(`✓ catalog built: ${catalog} — ${String(refs.length)} skills\n`);
    const bySource = new Map<SkillSourceKind, { total: number; functional: number }>();
    for (const ref of refs) {
      const currentCount = bySource.get(ref.source) ?? { total: 0, functional: 0 };
      bySource.set(ref.source, {
        total: currentCount.total + 1,
        functional: currentCount.functional + (ref.type === 'functional' ? 1 : 0),
      });
    }
    for (const [source, count] of bySource.entries()) {
      this.context.stdout.write(
        `   ${source.padEnd(7)} ${String(count.total)} (${String(count.functional)} functional)\n`,
      );
    }
    return 0;
  }

  private async scan(): Promise<readonly SkillRef[]> {
    const refs: SkillRef[] = [];
    const root = rootDir();
    for (const entry of await safeReaddir(root)) {
      if (!entry.isDirectory() || entry.name === '.system') continue;
      await this.pushSkill(
        refs,
        entry.name,
        'user',
        joinPath(joinPath(root, entry.name), 'SKILL.md'),
      );
    }
    for (const entry of await safeReaddir(joinPath(root, '.system'))) {
      if (!entry.isDirectory()) continue;
      await this.pushSkill(
        refs,
        entry.name,
        'system',
        joinPath(joinPath(joinPath(root, '.system'), entry.name), 'SKILL.md'),
      );
    }
    if (process.env.FUGUE_SKILLS_NO_PLUGINS !== '1') {
      for (const path of await findSkillFiles(pluginsDir())) {
        await this.pushSkill(refs, pluginId(path), 'plugin', path);
      }
    }
    refs.sort((a, b) => {
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    const byId = new Map<string, SkillRef>();
    for (const ref of refs) if (!byId.has(ref.id)) byId.set(ref.id, ref);
    return [...byId.values()];
  }

  private async pushSkill(
    refs: SkillRef[],
    id: string,
    source: SkillSourceKind,
    path: string,
  ): Promise<void> {
    const content = await this.fs.read(path);
    if (content === null) return;
    refs.push({
      id,
      source,
      type: classifyType(id, noteRe()),
      path,
      description: parseDescription(content),
    });
  }

  private async catalog(): Promise<readonly SkillRef[]> {
    const content = await this.fs.read(catalogPath());
    if (content === null || content.trim().length === 0) {
      await this.index([], true);
      return parseCatalog((await this.fs.read(catalogPath())) ?? '');
    }
    return parseCatalog(content);
  }

  private async list(args: readonly string[]): Promise<number> {
    let type = 'functional';
    let source = 'all';
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      const value = args[index + 1] ?? '';
      if (arg === '--type') {
        type = value;
        index += 1;
      } else if (arg === '--source') {
        source = value;
        index += 1;
      } else return this.error(`unknown arg '${arg ?? ''}'`);
    }
    for (const ref of await this.catalog()) {
      if ((type === 'all' || ref.type === type) && (source === 'all' || ref.source === source)) {
        this.context.stdout.write(
          `  ${ref.id.padEnd(42)} ${ref.source.padEnd(7)} ${ref.type.padEnd(11)} ${ref.description.slice(
            0,
            82,
          )}\n`,
        );
      }
    }
    return 0;
  }

  private async match(args: readonly string[]): Promise<number> {
    let query = '';
    let type = 'all';
    let source = 'all';
    let limit = 10;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      const value = args[index + 1] ?? '';
      if (arg === '--type') {
        type = value;
        index += 1;
      } else if (arg === '--source') {
        source = value;
        index += 1;
      } else if (arg === '--limit') {
        const parsed = Number.parseInt(value, 10);
        limit = Number.isFinite(parsed) ? parsed : 10;
        index += 1;
      } else if (arg.startsWith('-')) return this.error(`unknown arg '${arg}'`);
      else query = query.length > 0 ? `${query} ${arg}` : arg;
    }
    if (query.length === 0)
      return this.error('usage: match "<query>" [--type t] [--source s] [--limit N]');
    const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
    const scored = (await this.catalog())
      .filter((ref) => type === 'all' || ref.type === type)
      .filter((ref) => source === 'all' || ref.source === source)
      .map((ref) => ({
        ref,
        hits: words.filter((word) => `${ref.id} ${ref.description}`.toLowerCase().includes(word))
          .length,
      }))
      .filter((entry) => entry.hits > 0)
      .sort((a, b) => (a.hits !== b.hits ? b.hits - a.hits : a.ref.id < b.ref.id ? -1 : 1))
      .slice(0, Math.max(0, limit));
    for (const { ref, hits } of scored) {
      this.context.stdout.write(
        `  [${String(hits)}] ${ref.id.padEnd(38)} ${ref.source.padEnd(7)} ${ref.type.padEnd(
          11,
        )} ${ref.description.slice(0, 72)}\n`,
      );
    }
    return 0;
  }

  private async pathOf(id: string): Promise<string | null> {
    const ref = (await this.catalog()).find((candidate) => candidate.id === id);
    if (ref !== undefined) return ref.path;
    const fallback = joinPath(joinPath(rootDir(), id), 'SKILL.md');
    return (await exists(fallback)) ? fallback : null;
  }

  private async show(args: readonly string[]): Promise<number> {
    const id = args[0];
    if (id === undefined || id.length === 0) return this.error('usage: show <skill-id>');
    const path = await this.pathOf(id);
    const content = path === null ? null : await this.fs.read(path);
    if (path === null || content === null) return this.error(`no such skill: ${id}`);
    this.context.stdout.write(`── ${id} — ${path} ──\n${content}`);
    return 0;
  }

  private async inject(args: readonly string[]): Promise<number> {
    let ids = '';
    let full = false;
    for (const arg of args) {
      if (arg === '--full') full = true;
      else if (arg.startsWith('-')) return this.error(`unknown arg '${arg}'`);
      else ids = arg;
    }
    if (ids.length === 0) return this.error('usage: inject <id1,id2,...> [--full]');
    this.context.stdout.write(await this.renderInject(splitCsv(ids), full));
    return 0;
  }

  private async renderInject(ids: readonly string[], full: boolean): Promise<string> {
    const refs = await this.catalog();
    const lines = ['[Skills available for this task — crawl only the ones you need]'];
    for (const id of ids) {
      const ref = refs.find((candidate) => candidate.id === id);
      const path = ref?.path;
      const content = path === undefined ? null : await this.fs.read(path);
      if (full && path !== undefined && content !== null) {
        lines.push('', `===== SKILL: ${id} =====`, content.replace(/\s+$/u, ''));
      } else {
        lines.push(`- ${id} (${path ?? '?'}): ${ref?.description ?? '?'}`);
      }
    }
    if (!full)
      lines.push('Invoke a needed skill with the Skill tool, or Read its SKILL.md path above.');
    return `${lines.join('\n')}\n`;
  }

  private async validate(args: readonly string[]): Promise<number> {
    let id = '';
    let dir = '';
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      const value = args[index + 1] ?? '';
      if (arg === '--dir') {
        dir = value;
        index += 1;
      } else if (arg === '--official') {
        // Built-in validation is the portable fallback and mirrors the official gate closely.
      } else if (arg.startsWith('-')) return this.error(`unknown arg '${arg}'`);
      else id = arg;
    }
    if (dir.length === 0) {
      if (id.length === 0)
        return this.error('usage: validate <skill-id> | validate --dir <skill-dir> [--official]');
      const path = await this.pathOf(id);
      dir = path === null ? joinPath(rootDir(), id) : dirname(path);
    }
    const md = joinPath(dir, 'SKILL.md');
    const content = await this.fs.read(md);
    if (content === null) return this.fail(`✗ SKILL.md not found (${md})`);
    if (content.split(/\r?\n/u)[0] !== '---')
      return this.fail('✗ no YAML frontmatter (must start with ---)');
    const badKeys = frontmatterLines(content)
      .filter((line) => /^[A-Za-z][A-Za-z0-9_-]*:/u.test(line))
      .map((line) => line.replace(/:.*/u, ''))
      .filter(
        (key) => !['name', 'description', 'license', 'allowed-tools', 'metadata'].includes(key),
      );
    if (badKeys.length > 0)
      return this.fail(
        `✗ frontmatter has illegal key: ${badKeys.join(' ')}(allowed name/description/license/allowed-tools/metadata)`,
      );
    const name = field(content, 'name');
    if (name.length === 0) return this.fail('✗ frontmatter missing name');
    if (!/^[a-z0-9-]+$/u.test(name))
      return this.fail(`✗ name '${name}' must be hyphen-case (lowercase letters/digits/hyphens)`);
    if (/(^-|-$|--)/u.test(name))
      return this.fail(`✗ name '${name}' can't have leading/trailing hyphen or consecutive --`);
    if (name.length > 64) return this.fail(`✗ name too long (${String(name.length)}>64)`);
    const desc = parseDescriptionRaw(content);
    if (desc.length === 0) return this.fail('✗ frontmatter missing description');
    if (desc.includes('<') || desc.includes('>'))
      return this.fail("✗ description can't contain angle brackets (< or >)");
    if (desc.length > 1024)
      return this.fail(`✗ description too long (${String(desc.length)}>1024)`);
    this.context.stdout.write(`✓ valid: ${name} (${dir})\n`);
    return 0;
  }

  private async forge(args: readonly string[]): Promise<number> {
    let name = '';
    let fromExperience = '';
    let source = '';
    let fromStdin = false;
    let agent = '';
    let harness: HarnessName = 'fugue-cc';
    let targetDir = rootDir();
    let minChars = 200;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? '';
      const value = args[index + 1] ?? '';
      if (arg === '--name') {
        name = value;
        index += 1;
      } else if (arg === '--from-experience') {
        fromExperience = value;
        index += 1;
      } else if (arg === '--source') {
        source = value;
        index += 1;
      } else if (arg === '--material') fromStdin = true;
      else if (arg === '--agent') {
        agent = value;
        index += 1;
      } else if (arg === '--harness') {
        if (!isHarnessName(value)) return this.error(`unknown harness '${value}'`);
        harness = value;
        index += 1;
      } else if (arg === '--target-dir') {
        targetDir = value;
        index += 1;
      } else if (arg === '--min-chars') {
        const parsed = Number.parseInt(value, 10);
        minChars = Number.isFinite(parsed) ? parsed : minChars;
        index += 1;
      } else return this.error(`unknown arg '${arg}'`);
    }
    if (name.length === 0) return this.error('need --name <skill-id>');
    const material = await this.material({ fromExperience, source, fromStdin });
    if (material === null) return 2;
    if (material.length < minChars)
      return this.error(
        `material too thin (${String(material.length)}<${String(
          minChars,
        )} chars) — let the method mature/recur before forge (candidate gate)`,
      );

    const target = joinPath(targetDir, name);
    const brief = this.forgeBrief(name, target, material);
    if (agent.length > 0) {
      this.context.stdout.write(
        `▸ forge: dispatch ${agent} (inject skill-creator) to write skill '${name}' → ${target}\n`,
      );
      const prompt = `${await this.renderInject(['skill-creator'], false)}${brief}`;
      const result = await this.harnessFor(harness).dispatch({ agent, prompt });
      const rc = isOk(result) ? result.value.exitCode : (result.error.exitCode ?? 1);
      this.context.stdout.write(
        `→ after worker finishes run acceptance gate + reabsorb: \`fuguectl skills validate ${name} && fuguectl skills index --refresh\`\n`,
      );
      return rc;
    }
    this.context.stdout.write(
      `── forge brief (name=${name} - target=${target}) — hand to worker / skill-creator to execute ──\n`,
    );
    this.context.stdout.write(brief);
    this.context.stdout.write(
      `\n→ after skill is written pass acceptance gate then reabsorb into mother dir (closed loop): \`fuguectl skills validate ${name} && fuguectl skills index --refresh\`\n`,
    );
    return 0;
  }

  private async material(input: {
    readonly fromExperience: string;
    readonly source: string;
    readonly fromStdin: boolean;
  }): Promise<string | null> {
    if (input.fromExperience.length > 0) {
      const slash = input.fromExperience.indexOf('/');
      if (slash <= 0 || slash === input.fromExperience.length - 1)
        return this.errorNull('--from-experience format <ws>/<slug>');
      const method = await new FsExperienceStore(this.fs, systemClock, experienceRoot()).get(
        input.fromExperience.slice(0, slash),
        input.fromExperience.slice(slash + 1),
      );
      if (method === null || method.body.length === 0)
        return this.errorNull(`fetch experience failed/empty: ${input.fromExperience}`);
      return method.body;
    }
    if (input.source.length > 0) {
      const content = await this.fs.read(input.source);
      if (content === null) return this.errorNull(`no --source file ${input.source}`);
      return content;
    }
    if (input.fromStdin) return await readStdin(this.context.stdin);
    return this.errorNull(
      'need material: --from-experience <ws/slug> | --source <f> | --material(stdin)',
    );
  }

  private forgeBrief(name: string, target: string, material: string): string {
    return [
      `Author a new Claude Code skill named \`${name}\` using the **skill-creator** skill (injected above — follow its conciseness / degrees-of-freedom / frontmatter guidance).`,
      '',
      `Write it to \`${target}/SKILL.md\` (create the dir). Frontmatter needs \`name: ${name}\` + a \`description:\` with trigger phrases. Keep it concise.`,
      '',
      'Distill it from this precipitated material (a reusable method from prior work — keep the procedure, drop one-off specifics):',
      '',
      '<<<MATERIAL',
      material,
      'MATERIAL',
      '',
      `When done, print: DONE: ${target}/SKILL.md`,
      '',
    ].join('\n');
  }

  private harnessFor(name: HarnessName): Harness {
    const runner = new NodeCommandRunner();
    switch (name) {
      case 'fugue-cc':
        return new FugueCcHarness(runner, { bin: process.env.FUGUE_CC_BIN ?? 'fugue-cc' });
      case 'codex':
        return new CodexHarness(runner, { bin: process.env.FUGUE_CODEX ?? 'codex' });
      case 'opencode':
        return new OpencodeHarness(runner, { bin: process.env.FUGUE_OPENCODE ?? 'opencode' });
    }
  }

  private fail(message: string): number {
    this.context.stdout.write(`${message}\n`);
    return 1;
  }

  private error(message: string): number {
    this.context.stderr.write(`${message}\n`);
    return 2;
  }

  private errorNull(message: string): null {
    this.context.stderr.write(`${message}\n`);
    return null;
  }
}

const safeReaddir = async (dir: string): Promise<readonly Dirent<string>[]> => {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

const findSkillFiles = async (root: string): Promise<readonly string[]> => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await safeReaddir(dir)) {
      const path = joinPath(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name === 'SKILL.md') files.push(path);
    }
  };
  await walk(root);
  return files.sort();
};
