import { createHash } from 'node:crypto';

import { Command, Option } from 'clipanion';

import { FAILURE_CAUSES } from '../../domain/experience.js';
import {
  INCIDENT_HARNESS_LAYERS,
  INCIDENT_KINDS,
  INCIDENT_MAST_CATEGORIES,
  INCIDENT_PACKET_SCHEMA_VERSION,
  incidentPacket,
  incidentRecoveryPacket,
  renderIncidentPacket,
  renderIncidentRecoveryPacket,
  type IncidentEvidence,
  type IncidentPacket,
  type IncidentPacketIssue,
  type IncidentRecord,
} from '../../domain/incident-packet.js';
import { NodeFileSystem } from '../../infra/node-file-system.js';

const fs = (): NodeFileSystem => new NodeFileSystem();

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const readStream = async (stream: AsyncIterable<Buffer | string>): Promise<string> => {
  let out = '';
  for await (const chunk of stream) {
    out += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  return out;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isIncidentEvidence = (value: unknown): value is IncidentEvidence =>
  isRecord(value) && typeof value.line === 'number' && typeof value.excerpt === 'string';

const isIncidentRecord = (value: unknown): value is IncidentRecord =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (INCIDENT_KINDS as readonly string[]).includes(String(value.kind)) &&
  ['critical', 'major', 'minor', 'unknown'].includes(String(value.severity)) &&
  (FAILURE_CAUSES as readonly string[]).includes(String(value.failureCause)) &&
  (INCIDENT_MAST_CATEGORIES as readonly string[]).includes(String(value.mastCategory)) &&
  (INCIDENT_HARNESS_LAYERS as readonly string[]).includes(String(value.harnessLayer)) &&
  typeof value.summary === 'string' &&
  Array.isArray(value.evidence) &&
  value.evidence.every(isIncidentEvidence) &&
  isStringArray(value.recommendedChecks);

const isIncidentPacketIssue = (value: unknown): value is IncidentPacketIssue =>
  isRecord(value) &&
  ['no-incident-detected', 'incident-without-evidence'].includes(String(value.kind)) &&
  typeof value.detail === 'string';

const isIncidentPacket = (value: unknown): value is IncidentPacket =>
  isRecord(value) &&
  value.schemaVersion === INCIDENT_PACKET_SCHEMA_VERSION &&
  typeof value.sourceRef === 'string' &&
  typeof value.sourceSha256 === 'string' &&
  typeof value.sourceChars === 'number' &&
  typeof value.incidentCount === 'number' &&
  Array.isArray(value.incidents) &&
  value.incidents.every(isIncidentRecord) &&
  Array.isArray(value.issues) &&
  value.issues.every(isIncidentPacketIssue);

const parseIncidentPacketJson = (content: string): IncidentPacket | undefined => {
  try {
    const parsed: unknown = JSON.parse(content);
    return isIncidentPacket(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const incidentPacketFromInput = (
  content: string,
  options: { readonly sourceRef: string; readonly sourceSha256: string },
): IncidentPacket => parseIncidentPacketJson(content) ?? incidentPacket(content, options);

/** `fugue incident packet <file|->` — turn failure logs into a structured incident packet. */
export class IncidentPacketCommand extends Command {
  static override paths = [['incident', 'packet']];

  file = Option.String();
  sourceRef = Option.String('--source-ref');
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    const content =
      this.file === '-'
        ? await readStream(this.context.stdin as AsyncIterable<Buffer | string>)
        : await fs().read(this.file);
    if (content === null) {
      this.context.stderr.write(`no incident input file ${this.file}\n`);
      return 1;
    }
    if (content.trim().length === 0) {
      this.context.stderr.write('incident input is empty\n');
      return 1;
    }
    const packet = incidentPacket(content, {
      sourceRef: this.sourceRef ?? (this.file === '-' ? 'stdin' : this.file),
      sourceSha256: sha256(content),
    });
    this.context.stdout.write(
      this.json ? `${JSON.stringify(packet, null, 2)}\n` : renderIncidentPacket(packet),
    );
    return 0;
  }
}

/** `fugue incident recovery <file|->` — turn incident evidence into bounded recovery guidance. */
export class IncidentRecoveryCommand extends Command {
  static override paths = [['incident', 'recovery']];

  file = Option.String();
  sourceRef = Option.String('--source-ref');
  json = Option.Boolean('--json', false);

  override async execute(): Promise<number> {
    const content =
      this.file === '-'
        ? await readStream(this.context.stdin as AsyncIterable<Buffer | string>)
        : await fs().read(this.file);
    if (content === null) {
      this.context.stderr.write(`no incident input file ${this.file}\n`);
      return 1;
    }
    if (content.trim().length === 0) {
      this.context.stderr.write('incident input is empty\n');
      return 1;
    }
    const sourceRef = this.sourceRef ?? (this.file === '-' ? 'stdin' : this.file);
    const packet = incidentPacketFromInput(content, {
      sourceRef,
      sourceSha256: sha256(content),
    });
    const recovery = incidentRecoveryPacket(
      packet.sourceRef === sourceRef ? packet : { ...packet, sourceRef },
    );
    this.context.stdout.write(
      this.json ? `${JSON.stringify(recovery, null, 2)}\n` : renderIncidentRecoveryPacket(recovery),
    );
    return recovery.guidanceGate.disposition === 'blocked' ? 2 : 0;
  }
}
