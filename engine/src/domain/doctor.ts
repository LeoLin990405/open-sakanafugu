/** Environment recon (bash `doctor`): which role CLIs + backends are present, and the recommended workflow. */
export interface RoleStatus {
  readonly cli: string;
  readonly present: boolean;
}
export interface BackendStatus {
  readonly launcher: string;
  readonly installed: boolean;
  readonly keyConfigured: boolean;
}
export interface DoctorReport {
  readonly roles: readonly RoleStatus[];
  readonly backends: readonly BackendStatus[];
}

export const readyBackends = (report: DoctorReport): number =>
  report.backends.filter((b) => b.installed && b.keyConfigured).length;

const hasRole = (report: DoctorReport, cli: string): boolean =>
  report.roles.find((r) => r.cli === cli)?.present ?? false;

/** Recommended workflow given what's installed (pure port of the bash advisor). */
export const recommend = (report: DoctorReport): readonly string[] => {
  const recs: string[] = [];
  const ready = readyBackends(report);
  const ccb = hasRole(report, 'ccb');
  const codex = hasRole(report, 'codex');

  if (ccb && ready >= 2 && codex) {
    recs.push(
      'full fan-out: ccb multi-window → backends implement in parallel → Codex reviews → bounded loop',
    );
  } else if (ready >= 1 && !ccb) {
    recs.push(
      'single-machine lite: dispatch via the /cn:* plugin (no auto review loop); install ccb for full fan-out',
    );
  } else if (ready >= 1) {
    recs.push('half setup: fan out manually as needed');
  } else {
    recs.push(
      'no ready backend yet: install launchers + configure keys in ~/.config/cc-model-secrets.env',
    );
  }

  if (!codex) {
    recs.push(
      'no Codex (reviewer): use a strong Chinese-model backend as reviewer — do not use Gemini',
    );
  }
  if (!hasRole(report, 'claude')) {
    recs.push('no claude (executor): install @anthropic-ai/claude-code first');
  }
  return recs;
};
