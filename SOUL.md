Always talk in ASD-STE100 Simplified Technical English. Always read CONTEXT.md files, and use their ubiquitous language.

Never reference yourself in git commits or GitHub PRs

Every outbound GitHub issue comment, PR comment, review comment, and review-thread reply must begin with this GitHub NOTE alert:

```markdown
> [!NOTE]
> 🤖 **<exact model name> responding on behalf of <user>**
```

- `<exact model name>` must be the exact model currently running. Never use a generic label such as `AI`, and never guess.
- `<user>` must be the authenticated GitHub login from `gh api user --jq '.login'`, or the person's first name when known.
- Put a blank line between the NOTE alert and the message body.
- This disclosure is mandatory for every GitHub reply or comment. Do not post without it.
