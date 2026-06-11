# AGENTS.md instructions for /Users/misakamikoto/Downloads/AI/codex/langrensha

## Git Commit Attribution

- When creating commits in this repository, keep the primary author and committer as the user's configured Git identity.
- The expected primary Git identity is `Jiehao Sun <sunjh42a3@163.com>`.
- Add `Co-authored-by: Yutong <yutong43@illinois.edu>` to every commit message created for the user.
- Do not change the primary author to `yutong43@illinois.edu`; that account should be included only as a co-author.

## Review Scope Notes

- Do not report the in-room "暴露模式" tab as a defect. It is an intentional debug/observer mechanism that can reveal roles, backend reasons, prompts, raw model responses, and debug controls.
- Do not report real AI requests using no hard timeout (`timeoutMs=0`) as a defect. The current mechanism intentionally allows long-running provider/model-thinking calls; review it only if the user asks to change timeout behavior.
