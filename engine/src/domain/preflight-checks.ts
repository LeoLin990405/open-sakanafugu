import type { GateCheck, GateResult } from './gate.js';

// Parity with fuguectl preflight (deterministic provider config checks):
//   no-Gemini:   ^[^#]*(model|url)[[:space:]]*=.*(gemini|antigravity)   (case-insensitive)
//                ^[^#]* means the model/url token is not preceded by '#', so comment lines are ignored.
//   model line:  ^[[:space:]]*model[[:space:]]*=
//   empty model: ^[[:space:]]*model[[:space:]]*=[[:space:]]*"?"?[[:space:]]*$
const GEMINI_CONFIG = /^[^#]*(?:model|url)\s*=.*(?:gemini|antigravity)/iu;
const MODEL_LINE = /^\s*model\s*=/u;
const EMPTY_MODEL = /^\s*model\s*=\s*"?"?\s*$/u;

const splitLines = (text: string): readonly string[] => text.split(/\r?\n/u);

/** Deterministic go/no-go checks over a provider config file's text (IO-free). */
export const checkProviderConfig = (configText: string): GateResult => {
  const lines = splitLines(configText);
  const checks: GateCheck[] = [];

  checks.push(
    lines.some((line) => GEMINI_CONFIG.test(line))
      ? {
          name: 'no-gemini',
          severity: 'fail',
          detail:
            'provider config model/url contains gemini/antigravity — violates the no-Gemini hard rule',
        }
      : { name: 'no-gemini', severity: 'ok', detail: 'no-Gemini guard passed' },
  );

  const modelCount = lines.filter((line) => MODEL_LINE.test(line)).length;
  checks.push(
    modelCount > 0
      ? {
          name: 'model-configured',
          severity: 'ok',
          detail: `${modelCount} agent(s) configured a model`,
        }
      : { name: 'model-configured', severity: 'warn', detail: 'provider config has no model line' },
  );

  checks.push(
    lines.some((line) => EMPTY_MODEL.test(line))
      ? {
          name: 'model-nonempty',
          severity: 'fail',
          detail: 'provider config has an empty model value',
        }
      : { name: 'model-nonempty', severity: 'ok', detail: 'no empty model values' },
  );

  return { checks };
};
