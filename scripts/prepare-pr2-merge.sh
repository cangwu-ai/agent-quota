#!/usr/bin/env bash
# Run in a writable checkout of card-01 after fetching origin.
# Prepare the actual merge and its index; leave committing and pushing to the caller.
set -euo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

cd "$(git rev-parse --show-toplevel)"
[[ $(git branch --show-current) == card-01 ]] || fail '只能在 card-01 上准备合并。'
if git rev-parse --verify -q MERGE_HEAD >/dev/null; then
  fail '已有未完成的合并，请先检查当前合并状态。'
fi
git diff --quiet && git diff --cached --quiet || fail '有未提交的文件修改，请先由提交脚本保存。'

target=18fa0e3eb4c9527a144806684ea64c03812f4318
[[ $(git rev-parse --verify origin/main) == "$target" ]] || fail 'origin/main 已变化，请重新审查冲突，不能套用旧解决结果。'
if git merge-base --is-ancestor "$target" HEAD; then
  printf '%s\n' 'card-01 已包含目标 main 的历史，无需再次准备合并。'
  exit 0
fi

source_head=$(git rev-parse HEAD)
paths=(.gitignore README.md frontend/dashboard-model.mjs frontend/quota-data.mjs index.html)
# These exact files already combine main's frontend/PWA and PR#2's data fixes.
# Do not overwrite later changes with a resolution reviewed for another version.
while read -r expected path; do
  [[ $(git rev-parse "$source_head:$path") == "$expected" ]] || fail "解决结果已变化，请重新审查：$path"
done <<'RESOLUTIONS'
7a60b85e148f80966a550e5ab6a762a907c69ca6 .gitignore
7987e5d32fa29955e55bcf516c1ad93aead406e2 README.md
cf7876b42d46157341dc776fb8203f3cbcbe8aed frontend/dashboard-model.mjs
ef9bc1d9342fd6f4730d0f88972a29b3217531e7 frontend/quota-data.mjs
a6784c3f3c8ca5e3bbfab39927298b8f02f65033 index.html
RESOLUTIONS

if git -c rerere.enabled=false merge --no-ff --no-commit "$target"; then
  :
else
  result=$?
  [[ $result == 1 ]] || fail "git merge 失败（$result），请检查仓库状态。"
fi
[[ $(git rev-parse --verify MERGE_HEAD) == "$target" ]] || fail '合并未建立预期的第二父提交。'

while IFS= read -r path; do
  case "$path" in
    .gitignore|README.md|frontend/dashboard-model.mjs|frontend/quota-data.mjs|index.html) ;;
    *) fail "出现未审查的冲突，保留现场供检查：$path" ;;
  esac
done < <(git diff --name-only --diff-filter=U)

git restore --source="$source_head" --staged --worktree -- "${paths[@]}"
[[ -z $(git ls-files --unmerged) ]] || fail '仍有未解决的冲突。'
git diff --cached --check
printf '%s\n' '冲突已解决，MERGE_HEAD 已保留；请运行回归检查，再由提交脚本创建双父 merge commit 并推送 origin/card-01。'
printf '%s\n' '即使暂存差异为空，也必须保留这次合并的第二父提交。'
