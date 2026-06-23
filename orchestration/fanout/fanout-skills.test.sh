#!/usr/bin/env bash
# fanout-skills.test.sh — skills mother dir: 3 sources (user/system/plugin) + 5-col catalog + frontmatter parse + commands
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
S="$HERE/fanout-skills.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# shellcheck source=/dev/null
. "$HERE/fanout-testlib.sh"
has(){ case "$2" in *"$1"*) return 0;; *) return 1;; esac; }   # substring (avoid grep -P cross-platform)

# user source: functional(inline) + note(wdkns prefix) + functional(folded >-); system source; fake plugin marketplace
SK="$TMP/skills"; mkdir -p "$SK/my-tool" "$SK/wdkns-note-1" "$SK/folded-desc" "$SK/.system/sys-tool"
printf -- '---\nname: my-tool\ndescription: A real functional tool for doing X. Use when Y.\n---\n# my-tool body\n' > "$SK/my-tool/SKILL.md"
printf -- '---\nname: wdkns-note-1\ndescription: a learning note about Z\n---\n' > "$SK/wdkns-note-1/SKILL.md"
printf -- '---\nname: folded-desc\ndescription: >-\n  first line of folded\n  second line continues\nmetadata:\n  type: x\n---\nbody\n' > "$SK/folded-desc/SKILL.md"
printf -- '---\nname: sys-tool\ndescription: a SYSTEM meta tool for creating things\n---\n# sys body\n' > "$SK/.system/sys-tool/SKILL.md"
# fake plugin marketplace: marketplaces/<mp>/plugins/<plug>/skills/<skill>/ → id plug:skill
PL="$TMP/plugins"; mkdir -p "$PL/mymp/plugins/myplug/skills/myskill"
printf -- '---\nname: myskill\ndescription: a PLUGIN skill PLUGDESC here\n---\n# plug body\n' > "$PL/mymp/plugins/myplug/skills/myskill/SKILL.md"
export FANOUT_SKILLS_ROOT="$SK" FANOUT_PLUGINS_ROOT="$PL" FANOUT_SKILLS_CATALOG="$TMP/cat.tsv"

echo "fanout-skills tests"

# index: 3 user + 1 system + 1 plugin = 5
out="$(bash "$S" index --refresh)"
ok "index reports 5 skills" 'has "5 skills" "$out"'
ok "index by source user 3" 'has "user    3" "$out" || has "user   3" "$out"'
ok "index by source system 1" 'has "system" "$out"'
ok "index by source plugin 1" 'has "plugin" "$out"'
ok "catalog written to file" '[ -s "$FANOUT_SKILLS_CATALOG" ]'

# 5-col catalog: id source type path desc
ok "catalog: my-tool=user functional" 'has "$(printf "my-tool\tuser\tfunctional")" "$(cat "$FANOUT_SKILLS_CATALOG")"'
ok "catalog: wdkns-note-1=user note (prefix classification)" 'has "$(printf "wdkns-note-1\tuser\tnote")" "$(cat "$FANOUT_SKILLS_CATALOG")"'
ok "catalog: sys-tool=system" 'has "$(printf "sys-tool\tsystem")" "$(cat "$FANOUT_SKILLS_CATALOG")"'
ok "catalog: plugin id = myplug:myskill" 'grep -q "myplug:myskill" "$FANOUT_SKILLS_CATALOG"'
ok "catalog includes path column (.system path)" 'grep -q ".system/sys-tool/SKILL.md" "$FANOUT_SKILLS_CATALOG"'
ok "folded >- description joined into one line" 'grep -q "first line of folded second line continues" "$FANOUT_SKILLS_CATALOG"'
ok "folded description doesn't absorb metadata" '! grep -q "type: x" "$FANOUT_SKILLS_CATALOG"'

ok "index already exists → no rebuild" 'has "already exists" "$(bash "$S" index)"'

# list + --source
ok "list functional includes my-tool" 'bash "$S" list --type functional | grep -q my-tool'
ok "list functional excludes wdkns note" '! bash "$S" list --type functional | grep -q wdkns-note-1'
ok "list --source system includes sys-tool" 'bash "$S" list --source system | grep -q sys-tool'
ok "list --source plugin includes myplug:myskill" 'bash "$S" list --source plugin | grep -q "myplug:myskill"'
ok "list --source system excludes user's my-tool" '! bash "$S" list --source system | grep -q my-tool'

# match (+ --source)
ok "match 'system meta creating' → sys-tool" 'bash "$S" match "system meta creating" | grep -q sys-tool'
ok "match --source plugin 'PLUGDESC' → myplug:myskill" 'bash "$S" match "PLUGDESC plugin" --source plugin | grep -q "myplug:myskill"'

# show: cross-source path resolution
ok "show sys-tool resolves to .system path + body" 'bash "$S" show sys-tool | grep -q "sys body"'
ok "show plugin id myplug:myskill → plug body" 'bash "$S" show "myplug:myskill" | grep -q "plug body"'
bash "$S" show no-such >/dev/null 2>&1; ok "show nonexistent → nonzero" '[ "$?" -ne 0 ]'

# inject cross-source
out="$(bash "$S" inject "sys-tool,myplug:myskill")"
ok "inject includes sys-tool .system path" 'has ".system/sys-tool/SKILL.md" "$out"'
ok "inject includes plugin skill" 'has "myplug:myskill" "$out"'
ok "inject --full inlines plugin body" 'bash "$S" inject "myplug:myskill" --full | grep -q "plug body"'
bash "$S" inject >/dev/null 2>&1; ok "inject no args → nonzero" '[ "$?" -ne 0 ]'

# skip plugin source
out="$(FANOUT_SKILLS_NO_PLUGINS=1 bash "$S" index --refresh)"
ok "FANOUT_SKILLS_NO_PLUGINS=1 → don't scan plugin (4)" 'has "4 skills" "$out"'

# ── forge: closed loop precipitate→create→file back (after NO_PLUGINS, to avoid breaking earlier counts) ──
mkdir -p "$SK/.system/skill-creator"
printf -- '---\nname: skill-creator\ndescription: official skill authoring guide\n---\nGUIDE\n' > "$SK/.system/skill-creator/SKILL.md"
export FANOUT_EXPERIENCE="$TMP/exp"
MAT="$TMP/material.txt"
printf 'A reusable distilled method long enough to pass the candidate gate: step one do the thing, step two verify via harness, step three commit. Recurred across tasks; keep the procedure. Handle empty input and retry on transient errors.\n' > "$MAT"
bash "$S" index --refresh >/dev/null   # rebuild including skill-creator

out="$(bash "$S" forge --name foo-flow --source "$MAT")"
ok "forge brief includes skill-creator call" 'has "skill-creator" "$out"'
ok "forge brief includes name + material" 'has "foo-flow" "$out" && has "verify via harness" "$out"'
ok "forge brief includes index --refresh closed-loop hint" 'has "index --refresh" "$out"'
printf 'x\n' | bash "$S" forge --name tiny --material >/dev/null 2>&1; ok "forge candidate gate: material too thin → nonzero" '[ "$?" -ne 0 ]'
bash "$S" forge --source "$MAT" >/dev/null 2>&1; ok "forge missing --name → nonzero" '[ "$?" -ne 0 ]'
bash "$S" forge --name x >/dev/null 2>&1; ok "forge no material → nonzero" '[ "$?" -ne 0 ]'

bash "$HERE/fanout-experience.sh" add code "distilled method" --from "$MAT" >/dev/null 2>&1
out="$(bash "$S" forge --name from-exp --from-experience code/distilled-method)"
ok "forge --from-experience fetches experience body into brief" 'has "verify via harness" "$out"'
bash "$S" forge --name x --from-experience badformat >/dev/null 2>&1; ok "forge --from-experience bad format → nonzero" '[ "$?" -ne 0 ]'

# --agent dispatch: brief + skill-creator injected into worker stdin (ccb stub)
CCBSTUB="$TMP/ccb"; printf '#!/usr/bin/env bash\ncat > "%s"\n' "$TMP/forge-called" > "$CCBSTUB"; chmod +x "$CCBSTUB"
FANOUT_CCB="$CCBSTUB" bash "$S" forge --name viaworker --source "$MAT" --agent cc-x >/dev/null 2>&1
ok "forge --agent: brief into worker stdin" 'grep -q "viaworker" "$TMP/forge-called"'
ok "forge --agent: skill-creator injected" 'grep -q "official skill authoring guide" "$TMP/forge-called"'

# ── validate: quality gate (mirrors official quick_validate.py) ──
vmk(){ mkdir -p "$SK/$1"; printf -- '%s' "$2" > "$SK/$1/SKILL.md"; }
vmk v-good '---
name: v-good
description: a valid skill desc with triggers
metadata:
  k: v
---
body'
vmk v-badname '---
name: Bad_Name
description: ok
---'
vmk v-nodesc '---
name: v-nodesc
---'
vmk v-angle '---
name: v-angle
description: has <x> brackets
---'
vmk v-badkey '---
name: v-badkey
description: ok
weird_key: 1
---'
vmk v-folded '---
name: v-folded
description: >-
  folded one
  folded two
---'
bash "$S" validate --dir "$SK/v-good" >/dev/null 2>&1;   ok "validate valid → exit 0" '[ "$?" -eq 0 ]'
bash "$S" validate --dir "$SK/v-folded" >/dev/null 2>&1; ok "validate folded description valid → exit 0" '[ "$?" -eq 0 ]'
bash "$S" validate --dir "$SK/v-badname" >/dev/null 2>&1; ok "validate non hyphen-case name → nonzero" '[ "$?" -ne 0 ]'
bash "$S" validate --dir "$SK/v-nodesc" >/dev/null 2>&1;  ok "validate missing description → nonzero" '[ "$?" -ne 0 ]'
bash "$S" validate --dir "$SK/v-angle" >/dev/null 2>&1;   ok "validate description has angle brackets → nonzero" '[ "$?" -ne 0 ]'
bash "$S" validate --dir "$SK/v-badkey" >/dev/null 2>&1;  ok "validate illegal frontmatter key → nonzero" '[ "$?" -ne 0 ]'
bash "$S" validate --dir "$TMP/nonexist" >/dev/null 2>&1; ok "validate no SKILL.md → nonzero" '[ "$?" -ne 0 ]'
out="$(bash "$S" validate --dir "$SK/v-good" 2>&1)"; ok "validate valid reports ✓ valid" 'case "$out" in *"✓ valid"*) true;; *) false;; esac'
bash "$S" validate --dir "$SK/v-good" --official >/dev/null 2>&1; ok "validate --official no quick_validate falls back to built-in still passes" '[ "$?" -eq 0 ]'

# closed loop (with acceptance gate): forge → (worker writes skill) → validate passes → index --refresh → into mother dir
mkdir -p "$SK/forged-skill"; printf -- '---\nname: forged-skill\ndescription: a freshly forged skill\n---\nbody\n' > "$SK/forged-skill/SKILL.md"
bash "$S" validate forged-skill --dir "$SK/forged-skill" >/dev/null 2>&1; ok "closed loop: forge output passes acceptance gate" '[ "$?" -eq 0 ]'
bash "$S" index --refresh >/dev/null
ok "closed loop: validated skill enters mother dir after re-index" 'bash "$S" list --type functional | grep -q forged-skill'
# negative closed loop: invalid skill blocked by gate (shouldn't enter mother dir)
mkdir -p "$SK/Bad-Forge"; printf -- '---\nname: Bad_Forge\ndescription: invalid\n---\n' > "$SK/Bad-Forge/SKILL.md"
bash "$S" validate --dir "$SK/Bad-Forge" >/dev/null 2>&1; ok "negative closed loop: invalid skill blocked by acceptance gate (nonzero)" '[ "$?" -ne 0 ]'

bash "$S" bogus >/dev/null 2>&1; ok "unknown subcommand → nonzero" '[ "$?" -ne 0 ]'

tdone
