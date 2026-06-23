#!/usr/bin/env bash
# fanout-skills.sh — local skills master catalog (mother dir) + on-demand injection to agents (progressive disclosure)
#
# fanout philosophy = only feed what's needed. Hundreds of local skills, can't stuff all into every (weak) agent. Flow:
#   ① index  scan SKILL.md frontmatter of all skill sources → compact catalog (mother dir)
#   ② (Planner reads catalog, assigns skills to subtasks/agents — this step is judgment, not a tool)
#   ③ inject  inject selected skills as context, fed by `dispatch --skills` to that agent to crawl
#
# Three skill sources (all in mother dir, distinguished by source column):
#   user   ~/.claude/skills/<name>/         your skills
#   system ~/.claude/skills/.system/<name>/ system meta-skills (skill-creator/plugin-creator/skill-installer/imagegen/openai-docs)
#   plugin ~/.claude/plugins/marketplaces/.../skills/<name>/  plugin marketplace skills (official + cn/impeccable/codex…); id=plugin:skill
#
#   index [--refresh]                rebuild catalog (default builds only if missing; --refresh forces)
#   list  [--type functional|note|all] [--source user|system|plugin|all]   list catalog
#   match "<query>" [--type t] [--source s] [--limit N]   grep-match relevant skills (sorted by hit count)
#   show  <id>                       print a skill's path + SKILL.md (for crawling)
#   inject <id1,id2,...> [--full]    generate prompt-injectable skill context block (--full inlines full SKILL.md)
#   validate <id> | --dir <d> [--official]   skill quality gate (mirrors official quick_validate; --official uses local quick_validate.py)
#   forge --name <id> (--from-experience <ws/slug> | --source <f> | --material<stdin>) [--agent A] [--harness h] [--target-dir d] [--min-chars N]
#        closed loop 'precipitate→create→file back into category': fetch material → candidate gate (material thick enough) → assemble authoring brief → (--agent dispatches worker injecting
#        skill-creator to write; else prints brief) → hints `skills index --refresh` to absorb into mother dir. Delegates authoring to skill-creator, doesn't re-build distillation.
#   env: FANOUT_SKILLS_ROOT(default ~/.claude/skills) FANOUT_PLUGINS_ROOT(default ~/.claude/plugins/marketplaces)
#        FANOUT_SKILLS_CATALOG(catalog path) FANOUT_SKILLS_NOTE_RE(note prefix regex) FANOUT_SKILLS_NO_PLUGINS=1(skip plugin)
set -uo pipefail
# shellcheck source=/dev/null
. "$(dirname "${BASH_SOURCE[0]}")/fanout-lib.sh"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${FANOUT_SKILLS_ROOT:-$HOME/.claude/skills}"
PLUGINS="${FANOUT_PLUGINS_ROOT:-$HOME/.claude/plugins/marketplaces}"
CATALOG="${FANOUT_SKILLS_CATALOG:-${FANOUT_STATE:-$HOME/.config/fanout}/skills-catalog.tsv}"
NOTE_RE="${FANOUT_SKILLS_NOTE_RE:-^(wdkns|book|csdiy|dlai|mit|mooc|child|tu-online)}"

# shared awk: read SKILL.md, parse frontmatter, output "id<TAB>source<TAB>type<TAB>path<TAB>desc"
# -v src=source  -v idmode=dirname|plugin (plugin: .../plugins/<P>/skills/<S>/ → P:S)
_AWK='
  function pid(  n,p,i,plug,sk){ n=split(FILENAME,p,"/")
    if(idmode=="plugin"){ plug="";sk=""
      for(i=1;i<=n;i++){ if(p[i]=="plugins")plug=p[i+1]; if(p[i]=="skills")sk=p[i+1] }
      if(plug!="" && sk!="") return plug":"sk
      return p[n-1] }
    return p[n-1] }
  function flush(){ if(id!=""){ gsub(/^[ \t]+|[ \t]+$/,"",desc); gsub(/[ \t]+/," ",desc)
      if(length(desc)>160) desc=substr(desc,1,157)"..."
      t=(id ~ note_re)?"note":"functional"
      printf "%s\t%s\t%s\t%s\t%s\n", id, src, t, path, desc } }
  FNR==1{ flush(); id=pid(); path=FILENAME; desc=""; infront=0; fc=0; indesc=0 }
  /^---[ \t]*$/{ fc++; if(fc==1){infront=1;next} if(fc>=2){infront=0} next }
  infront && /^description:/{ r=$0; sub(/^description:[ \t]*/,"",r)
    if(r ~ /^[>|]/ || r==""){ desc=""; indesc=1 } else { desc=r; indesc=0 } next }
  infront && indesc && /^[ \t]/{ l=$0; sub(/^[ \t]+/,"",l); desc=desc" "l; next }
  infront && /^[A-Za-z_]+:/{ indesc=0 }
  END{ flush() }'

_scan_into(){ # <find-cmd via stdin null-list> <src> <idmode>
  xargs -0 awk -v note_re="$NOTE_RE" -v src="$2" -v idmode="$3" "$_AWK"
}
_scan(){
  {
    find "$ROOT" -mindepth 2 -maxdepth 2 -name SKILL.md -not -path '*/.system/*' -print0 2>/dev/null | _scan_into - user   dirname
    find "$ROOT/.system" -mindepth 2 -maxdepth 2 -name SKILL.md -print0 2>/dev/null              | _scan_into - system dirname
    if [ "${FANOUT_SKILLS_NO_PLUGINS:-0}" != 1 ] && [ -d "$PLUGINS" ]; then
      find "$PLUGINS" -name SKILL.md -print0 2>/dev/null | _scan_into - plugin plugin
    fi
  } | sort -t"$(printf '\t')" -k1,1 -u   # dedupe by id (avoid plugin cache duplicates)
}

cmd_index(){
  local refresh=0; [ "${1:-}" = "--refresh" ] && refresh=1
  [ -d "$ROOT" ] || die "no skills root: $ROOT"
  if [ "$refresh" -eq 0 ] && [ -s "$CATALOG" ]; then
    echo "✓ catalog already exists: $CATALOG ($(grep -c . "$CATALOG") entries; --refresh rebuilds)"; return 0
  fi
  mkdir -p "$(dirname "$CATALOG")"
  _scan > "$CATALOG.tmp" && mv -f "$CATALOG.tmp" "$CATALOG"
  local n; n="$(grep -c . "$CATALOG")"
  echo "✓ catalog built: $CATALOG — $n skills"
  awk -F'\t' '$1!=""{ s[$2]++; if($3=="functional") sf[$2]++ } END{ for(k in s) printf "   %-7s %d (%d functional)\n",k,s[k],sf[k]+0 }' "$CATALOG"
}

_need_catalog(){ [ -s "$CATALOG" ] || cmd_index >/dev/null; }

cmd_list(){
  local type="functional" source="all"
  while [ "$#" -gt 0 ]; do case "$1" in
    --type) type="${2:-}"; shift 2;; --source) source="${2:-}"; shift 2;; *) die "unknown arg '$1'";; esac
  done
  _need_catalog
  awk -F'\t' -v t="$type" -v s="$source" '$1!=""{
    if((t=="all"||$3==t) && (s=="all"||$2==s)) printf "  %-42s %-7s %-11s %s\n",$1,$2,$3,substr($5,1,82) }' "$CATALOG"
}

cmd_match(){
  local query="" type="all" source="all" limit=10
  while [ "$#" -gt 0 ]; do case "$1" in
    --type) type="${2:-}"; shift 2;; --source) source="${2:-}"; shift 2;; --limit) limit="${2:-10}"; shift 2;;
    -*) die "unknown arg '$1'";; *) query="${query:+$query }$1"; shift;; esac
  done
  [ -n "$query" ] || die "usage: match \"<query>\" [--type t] [--source s] [--limit N]"
  _need_catalog
  awk -F'\t' -v q="$query" -v type="$type" -v src="$source" '
    $1=="" {next}
    { if(type!="all" && $3!=type) next; if(src!="all" && $2!=src) next
      hay=tolower($1" "$5); nq=split(tolower(q),qa," "); hits=0
      for(i=1;i<=nq;i++){ w=qa[i]; if(w!="" && index(hay,w)) hits++ }
      if(hits>0) printf "%d\t%s\t%s\t%s\t%s\n", hits,$1,$2,$3,$5 }' "$CATALOG" \
    | sort -t"$(printf '\t')" -k1,1nr -k2,2 | head -n "$limit" \
    | awk -F'\t' '{printf "  [%s] %-38s %-7s %-11s %s\n",$1,$2,$3,$4,substr($5,1,72)}'
}

# id → SKILL.md path (first check catalog's path column; if not found fall back to user dir)
_path_of(){ _need_catalog; local p; p="$(awk -F'\t' -v k="$1" '$1==k{print $4; exit}' "$CATALOG")"
  [ -n "$p" ] && { printf '%s' "$p"; return 0; }
  [ -f "$ROOT/$1/SKILL.md" ] && printf '%s' "$ROOT/$1/SKILL.md"; }

cmd_show(){
  local id="${1:-}"; [ -n "$id" ] || die "usage: show <skill-id>"
  local f; f="$(_path_of "$id")"; [ -n "$f" ] && [ -f "$f" ] || die "no such skill: $id"
  echo "── $id — $f ──"; cat "$f"
}

cmd_inject(){
  local ids="" full=0
  while [ "$#" -gt 0 ]; do case "$1" in --full) full=1; shift;; -*) die "unknown arg '$1'";; *) ids="$1"; shift;; esac; done
  [ -n "$ids" ] || die "usage: inject <id1,id2,...> [--full]"
  _need_catalog
  echo "[Skills available for this task — crawl only the ones you need]"
  local IFS=','; local id
  for id in $ids; do
    [ -n "$id" ] || continue
    local f desc
    f="$(_path_of "$id")"; desc="$(awk -F'\t' -v k="$id" '$1==k{print $5; exit}' "$CATALOG")"
    if [ "$full" -eq 1 ] && [ -n "$f" ] && [ -f "$f" ]; then
      echo ""; echo "===== SKILL: $id ====="; cat "$f"
    else
      printf -- '- %s (%s): %s\n' "$id" "${f:-?}" "${desc:-?}"
    fi
  done
  [ "$full" -eq 1 ] || echo "Invoke a needed skill with the Skill tool, or Read its SKILL.md path above."
}

# validate: quality gate before a skill enters mother dir (mirrors official skill-creator quick_validate.py; self-contained, no PyYAML dependency)
#   --official: when local quick_validate.py + python3+pyyaml available, prefer the official one; else use built-in
cmd_validate(){
  local id="" dir="" official=0
  while [ "$#" -gt 0 ]; do case "$1" in
    --dir) dir="${2:-}"; shift 2;; --official) official=1; shift;; -*) die "unknown arg '$1'";; *) id="$1"; shift;; esac
  done
  if [ -z "$dir" ]; then
    [ -n "$id" ] || die "usage: validate <skill-id> | validate --dir <skill-dir> [--official]"
    local p; p="$(_path_of "$id" 2>/dev/null)"
    if [ -n "$p" ]; then dir="$(dirname "$p")"; else dir="$ROOT/$id"; fi
  fi
  local md="$dir/SKILL.md"
  # --official: skill-creator official quick_validate.py (if python3+pyyaml available)
  if [ "$official" -eq 1 ]; then
    local qv
    for qv in "$ROOT/.system/skill-creator/scripts/quick_validate.py" "$PLUGINS"/*/plugins/skill-creator/scripts/quick_validate.py; do
      [ -f "$qv" ] || continue
      if command -v python3 >/dev/null 2>&1 && python3 -c 'import yaml' >/dev/null 2>&1; then
        echo "(using official quick_validate.py)"; python3 "$qv" "$dir"; return $?
      fi
    done
    echo "(official quick_validate.py/pyyaml unavailable → using built-in check)" >&2
  fi
  # built-in check (mirrors quick_validate.py's checks)
  [ -f "$md" ] || { echo "✗ SKILL.md not found ($md)"; return 1; }
  head -1 "$md" | grep -qx -- '---' || { echo "✗ no YAML frontmatter (must start with ---)"; return 1; }
  local badkeys; badkeys="$(awk 'NR==1&&/^---/{f=1;next} f&&/^---/{exit}
    f&&/^[A-Za-z][A-Za-z0-9_-]*:/{k=$0;sub(/:.*/,"",k); if(k!="name"&&k!="description"&&k!="license"&&k!="allowed-tools"&&k!="metadata")print k}' "$md")"
  [ -z "$badkeys" ] || { echo "✗ frontmatter has illegal key: $(echo "$badkeys"|tr '\n' ' ')(allowed name/description/license/allowed-tools/metadata)"; return 1; }
  local name; name="$(awk 'NR==1&&/^---/{f=1;next} f&&/^---/{exit} f&&/^name:/{sub(/^name:[ \t]*/,"");sub(/[ \t]*$/,"");print;exit}' "$md")"
  [ -n "$name" ] || { echo "✗ frontmatter missing name"; return 1; }
  printf '%s' "$name" | grep -qE '^[a-z0-9-]+$' || { echo "✗ name '$name' must be hyphen-case (lowercase letters/digits/hyphens)"; return 1; }
  printf '%s' "$name" | grep -qE '(^-|-$|--)' && { echo "✗ name '$name' can't have leading/trailing hyphen or consecutive --"; return 1; }
  [ "${#name}" -le 64 ] || { echo "✗ name too long (${#name}>64)"; return 1; }
  local desc; desc="$(awk 'NR==1&&/^---/{f=1;next} f&&/^---/{exit}
    f&&/^description:/{r=$0;sub(/^description:[ \t]*/,"",r); if(r~/^[>|]/||r==""){indesc=1;d=""}else{d=r} next}
    f&&indesc&&/^[ \t]/{l=$0;sub(/^[ \t]+/,"",l);d=(d==""?l:d" "l);next}
    f&&indesc&&/^[A-Za-z_]+:/{indesc=0} END{print d}' "$md")"
  [ -n "$desc" ] || { echo "✗ frontmatter missing description"; return 1; }
  case "$desc" in *"<"*|*">"*) echo "✗ description can't contain angle brackets (< or >)"; return 1;; esac
  [ "${#desc}" -le 1024 ] || { echo "✗ description too long (${#desc}>1024)"; return 1; }
  echo "✓ valid: $name ($dir)"; return 0
}

# forge: orchestrator for closed loop 'precipitate→create→file back into category' (delegates authoring to skill-creator, doesn't re-build)
cmd_forge(){
  local name="" fromexp="" source="" from_stdin=0 agent="" harness="ccb" targetdir="$ROOT" minchars=200
  while [ "$#" -gt 0 ]; do case "$1" in
    --name)            name="${2:-}"; shift 2;;
    --from-experience) fromexp="${2:-}"; shift 2;;
    --source)          source="${2:-}"; shift 2;;
    --material)        from_stdin=1; shift;;
    --agent)           agent="${2:-}"; shift 2;;
    --harness)         harness="${2:-}"; shift 2;;
    --target-dir)      targetdir="${2:-}"; shift 2;;
    --min-chars)       minchars="${2:-}"; shift 2;;
    *) die "unknown arg '$1'";;
  esac; done
  [ -n "$name" ] || die "need --name <skill-id>"
  # fetch material
  local material=""
  if [ -n "$fromexp" ]; then
    local ws="${fromexp%%/*}" slug="${fromexp#*/}"
    [ "$ws" != "$fromexp" ] && [ -n "$slug" ] || die "--from-experience format <ws>/<slug>"
    material="$(bash "$HERE/fanout-experience.sh" show "$ws" "$slug" 2>/dev/null | sed '1,/^---$/d; /^---$/d')"
    [ -n "$material" ] || die "fetch experience failed/empty: $fromexp"
  elif [ -n "$source" ]; then
    [ -f "$source" ] || die "no --source file $source"; material="$(cat "$source")"
  elif [ "$from_stdin" -eq 1 ]; then
    material="$(cat)"
  else die "need material: --from-experience <ws/slug> | --source <f> | --material(stdin)"; fi
  # candidate gate: material too thin not worth precipitating into a skill (borrows wdkns-child-013 skill candidate-gate idea)
  [ "${#material}" -ge "$minchars" ] 2>/dev/null || die "material too thin (${#material}<$minchars chars) — let the method mature/recur before forge (candidate gate)"

  local target="$targetdir/$name" brief; brief="$(mktemp)"
  {
    echo "Author a new Claude Code skill named \`$name\` using the **skill-creator** skill (injected above — follow its conciseness / degrees-of-freedom / frontmatter guidance)."
    echo ""
    echo "Write it to \`$target/SKILL.md\` (create the dir). Frontmatter needs \`name: $name\` + a \`description:\` with trigger phrases. Keep it concise."
    echo ""
    echo "Distill it from this precipitated material (a reusable method from prior work — keep the procedure, drop one-off specifics):"
    echo ""
    echo "<<<MATERIAL"
    printf '%s\n' "$material"
    echo "MATERIAL"
    echo ""
    echo "When done, print: DONE: $target/SKILL.md"
  } > "$brief"

  if [ -n "$agent" ]; then
    echo "▸ forge: dispatch $agent (inject skill-creator) to write skill '$name' → $target"
    bash "$HERE/fanout-dispatch.sh" "$agent" --harness "$harness" --skills skill-creator --prompt-file "$brief"; local rc=$?
    rm -f "$brief"
    echo "→ after worker finishes run acceptance gate + reabsorb: \`fanout skills validate $name && fanout skills index --refresh\`"
    return "$rc"
  fi
  echo "── forge brief (name=$name - target=$target) — hand to worker / skill-creator to execute ──"
  cat "$brief"; rm -f "$brief"
  echo ""
  echo "→ after skill is written pass acceptance gate then reabsorb into mother dir (closed loop): \`fanout skills validate $name && fanout skills index --refresh\`"
}

sub="${1:-}"; shift || true
case "$sub" in
  index)    cmd_index    "$@";;
  list)     cmd_list     "$@";;
  match)    cmd_match    "$@";;
  show)     cmd_show     "$@";;
  inject)   cmd_inject   "$@";;
  validate) cmd_validate "$@";;
  forge)    cmd_forge    "$@";;
  ''|-h|--help) sed -n '2,27p' "$0";;
  *) die "unknown subcommand '$sub' (index|list|match|show|inject|validate|forge)";;
esac
