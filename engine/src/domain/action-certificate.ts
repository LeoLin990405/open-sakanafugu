export const ACTION_CERTIFICATE_SCHEMA_VERSION = 'fugunano.action-certificate.v1' as const;

export const ACTION_APPROVAL_CLASSES = [
  'not-required',
  'operator-reviewed',
  'runtime-enforced',
  'external-approval',
] as const;

export type ActionApprovalClass = (typeof ACTION_APPROVAL_CLASSES)[number];

export const isActionApprovalClass = (value: string): value is ActionApprovalClass =>
  (ACTION_APPROVAL_CLASSES as readonly string[]).includes(value);

export const ACTION_CHECKPOINT_KINDS = [
  'pre-action-admissibility',
  'action-open',
  'assumption-capture',
  'approval',
  'outcome-closure',
] as const;

export type ActionCheckpointKind = (typeof ACTION_CHECKPOINT_KINDS)[number];

export type ActionCheckpointStatus = 'passed' | 'recorded' | 'not-required' | 'failed';

export interface ActionCertificateCheckpoint {
  readonly kind: ActionCheckpointKind;
  readonly status: ActionCheckpointStatus;
  readonly evidence: readonly string[];
  readonly at?: string;
}

export interface ActionCertificateRuntime {
  readonly harness: string;
  readonly target: string;
}

export interface ActionCertificateAction {
  readonly promptSha256: string;
  readonly promptChars: number;
  readonly taskRef?: string;
  readonly taskType?: string;
  readonly workspace?: string;
}

export interface ActionCertificateApproval {
  readonly class: ActionApprovalClass;
}

export interface ActionCertificateOutcome {
  readonly status: 'ok' | 'failed';
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputChars: number;
  readonly outputSha256?: string;
  readonly outputPath?: string;
  readonly errorKind?: string;
}

export interface ActionCertificate {
  readonly schemaVersion: typeof ACTION_CERTIFICATE_SCHEMA_VERSION;
  readonly actionId: string;
  readonly issuedAt: string;
  readonly runtime: ActionCertificateRuntime;
  readonly action: ActionCertificateAction;
  readonly approval: ActionCertificateApproval;
  readonly assumptions: readonly string[];
  readonly externalities: readonly string[];
  readonly outcome: ActionCertificateOutcome;
  readonly checkpoints: readonly ActionCertificateCheckpoint[];
}

export interface BuildActionCertificateInput {
  readonly actionId: string;
  readonly issuedAt: string;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly runtime: ActionCertificateRuntime;
  readonly action: ActionCertificateAction;
  readonly approvalClass: ActionApprovalClass;
  readonly assumptions?: readonly string[];
  readonly externalities?: readonly string[];
  readonly outcome: ActionCertificateOutcome;
}

const nonEmpty = (values: readonly string[] | undefined): readonly string[] =>
  values?.map((value) => value.trim()).filter((value) => value.length > 0) ?? [];

export const buildActionCertificate = (input: BuildActionCertificateInput): ActionCertificate => {
  const assumptions = nonEmpty(input.assumptions);
  const externalities = nonEmpty(input.externalities);
  const assumptionEvidence = [
    ...assumptions,
    ...externalities.map((fact) => `externality: ${fact}`),
  ];
  const approvalEvidence =
    input.approvalClass === 'not-required'
      ? ['approval not required for this dispatch']
      : [`approval class: ${input.approvalClass}`];
  const outcomeEvidence = [
    `rc=${String(input.outcome.exitCode)}`,
    `output_chars=${String(input.outcome.outputChars)}`,
    ...(input.outcome.outputSha256 === undefined
      ? []
      : [`output_sha256=${input.outcome.outputSha256}`]),
    ...(input.outcome.errorKind === undefined ? [] : [`error=${input.outcome.errorKind}`]),
  ];

  return {
    schemaVersion: ACTION_CERTIFICATE_SCHEMA_VERSION,
    actionId: input.actionId,
    issuedAt: input.issuedAt,
    runtime: input.runtime,
    action: input.action,
    approval: { class: input.approvalClass },
    assumptions,
    externalities,
    outcome: input.outcome,
    checkpoints: [
      {
        kind: 'pre-action-admissibility',
        status: 'passed',
        at: input.openedAt,
        evidence: ['harness name validated', 'prompt resolved before runtime dispatch'],
      },
      {
        kind: 'action-open',
        status: 'recorded',
        at: input.openedAt,
        evidence: ['dispatch start recorded before runtime invocation'],
      },
      {
        kind: 'assumption-capture',
        status: assumptionEvidence.length === 0 ? 'not-required' : 'recorded',
        at: input.openedAt,
        evidence:
          assumptionEvidence.length === 0
            ? ['no operator assumptions or externality facts supplied']
            : assumptionEvidence,
      },
      {
        kind: 'approval',
        status: input.approvalClass === 'not-required' ? 'not-required' : 'recorded',
        at: input.openedAt,
        evidence: approvalEvidence,
      },
      {
        kind: 'outcome-closure',
        status: input.outcome.status === 'ok' ? 'passed' : 'failed',
        at: input.closedAt,
        evidence: outcomeEvidence,
      },
    ],
  };
};
