import type { AddMethod, ExperienceError, Method, RecallOptions } from '../../domain/experience.js';
import { containsSecret, slugify } from '../../domain/experience-redact.js';
import type { ExperienceStore } from '../../domain/ports/experience-store.js';
import { err, ok } from '../../domain/result.js';
import type { Result } from '../../domain/result.js';
import type { Clock } from '../../infra/clock.js';
import type { FileSystem } from '../../infra/file-system.js';
import { joinPath } from '../store/paths.js';

const renderMethod = (m: Method): string =>
  `---\nworkspace: ${m.workspace}\ntitle: ${m.title}\ncreated: ${m.created}\n---\n${m.body}\n`;

const parseMethod = (content: string, workspace: string, slug: string): Method => {
  const lines = content.split(/\r?\n/u);
  let start = -1;
  let end = -1;
  for (const [index, line] of lines.entries()) {
    if (line === '---') {
      if (start === -1) start = index;
      else {
        end = index;
        break;
      }
    }
  }
  const fm = start !== -1 && end !== -1 ? lines.slice(start + 1, end) : [];
  const fmField = (key: string): string => {
    const prefix = `${key}: `;
    const line = fm.find((entry) => entry.startsWith(prefix));
    return line !== undefined ? line.slice(prefix.length) : '';
  };
  const created = Number.parseInt(fmField('created'), 10);
  const body =
    end !== -1
      ? lines
          .slice(end + 1)
          .join('\n')
          .replace(/\n+$/u, '')
      : content;
  return {
    workspace,
    title: fmField('title'),
    slug,
    created: Number.isFinite(created) ? created : 0,
    body,
  };
};

const byWorkspaceSlug = (a: Method, b: Method): number => {
  if (a.workspace !== b.workspace) return a.workspace < b.workspace ? -1 : 1;
  if (a.slug === b.slug) return 0;
  return a.slug < b.slug ? -1 : 1;
};

const QUERY_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'this',
  'to',
  'use',
  'with',
]);

const queryTerms = (query: string | undefined): readonly string[] => {
  if (query === undefined) return [];
  const terms = query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter((term) => !QUERY_STOP_WORDS.has(term)))];
};

const experienceScore = (method: Method, terms: readonly string[]): number => {
  const methodTerms = new Set(queryTerms(`${method.title}\n${method.body}`));
  return terms.filter((term) => methodTerms.has(term)).length;
};

const methodFailureCause = (method: Method): string | undefined => {
  const lines = method.body.split(/\r?\n/u);
  const index = lines.findIndex((line) => line === 'Failure cause:');
  return index === -1 ? undefined : lines[index + 1]?.trim().toLowerCase();
};

/** Filesystem-backed experience store: `<root>/<workspace>/<slug>.md` (frontmatter + body). */
export class FsExperienceStore implements ExperienceStore {
  constructor(
    private readonly fs: FileSystem,
    private readonly clock: Clock,
    private readonly rootDir: string,
  ) {}

  async add(input: AddMethod): Promise<Result<Method, ExperienceError>> {
    if (input.body.length === 0) {
      return err({ kind: 'empty-body', detail: 'experience body is empty' });
    }
    if (containsSecret(input.body)) {
      return err({
        kind: 'contains-secret',
        detail: 'body contains a suspected key; redact first',
      });
    }
    const method: Method = {
      workspace: input.workspace,
      title: input.title,
      slug: slugify(input.title),
      created: Math.floor(this.clock.now() / 1000),
      body: input.body,
    };
    await this.fs.write(this.path(method.workspace, method.slug), renderMethod(method));
    return ok(method);
  }

  async get(workspace: string, slug: string): Promise<Method | null> {
    const content = await this.fs.read(this.path(workspace, slug));
    return content === null ? null : parseMethod(content, workspace, slug);
  }

  async list(workspace?: string): Promise<readonly Method[]> {
    if (workspace !== undefined) return (await this.methodsIn(workspace)).sort(byWorkspaceSlug);
    const workspaces = await this.fs.list(this.rootDir);
    const all: Method[] = [];
    for (const ws of workspaces) all.push(...(await this.methodsIn(ws)));
    return all.sort(byWorkspaceSlug);
  }

  async recall(workspace: string, options: RecallOptions = {}): Promise<readonly Method[]> {
    const limit = options.limit ?? 3;
    let methods = await this.methodsIn(workspace);
    if (options.failureCause !== undefined) {
      methods = methods.filter((method) => methodFailureCause(method) === options.failureCause);
    }
    const terms = queryTerms(options.query);
    if (terms.length > 0) {
      methods = methods
        .map((method) => ({ method, score: experienceScore(method, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || b.method.created - a.method.created)
        .map((entry) => entry.method);
    } else {
      methods.sort((a, b) => b.created - a.created); // most recent first
    }
    return methods.slice(0, Math.max(0, limit));
  }

  private async methodsIn(workspace: string): Promise<Method[]> {
    const names = await this.fs.list(joinPath(this.rootDir, workspace));
    const methods: Method[] = [];
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const method = await this.get(workspace, name.slice(0, -'.md'.length));
      if (method !== null) methods.push(method);
    }
    return methods;
  }

  private path(workspace: string, slug: string): string {
    return joinPath(joinPath(this.rootDir, workspace), `${slug}.md`);
  }
}
