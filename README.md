# pi-riddler

A [pi](https://pi.dev/) extension that adds an `ask_user` tool. The agent asks one or more questions. You answer with a pre-written option **or** free text, and both are always available.

## Features

- Several questions per call (max 5), shown as tabs with a review tab
- Question kinds: `single` (default), `multi` (checkboxes), `bool` (True/False), `input` (free text only)
- Options can carry a ★ recommendation, a rationale, a code example (with language) and a source reference. These appear in a detail panel for the highlighted option.
- Free-text field is always visible (hide it with `allowFreeText: false`). Text typed there is attached as a note when you pick an option.
- Optional timeout with a live countdown (`timeoutPerQuestionMs`); `Alt+Q` stops the countdown
- Honors the tool abort signal
- Validation with clear errors (limits, duplicate ids, empty options); duplicate option labels are dropped with a warning
- Native dialog fallback (`select`/`input`) when there is no custom TUI, e.g. RPC mode
- Tool results tell the model what to do on cancel, timeout or error, and never to invent an answer
- Events on `pi.events`: `herdr:blocked` (`{active}`), `ask:answered`, `ask:aborted`, `ask:timeout`, `ask:error`

## Install

```sh
pi install /path/to/pi-riddler
# or try it without installing:
pi -e ./extensions/ask-user.ts
```

Restart pi or run `/reload` afterwards.

## Keys

| Key | Action |
| --- | --- |
| ↑ / ↓, 1-9 | Move between options |
| Enter | Pick option (text field content becomes a note); on multi, confirm the checked set |
| Space | Toggle option on multi questions; pick on single/bool |
| Tab, or just type | Switch to free-text field; Enter submits it |
| ← / → , Shift+Tab | Switch question |
| Ctrl+Enter | Submit when all questions are answered |
| Alt+Q | Stop the timeout countdown |
| Esc | Cancel |

## Tool parameters

```json
{
  "allowFreeText": true,
  "timeoutPerQuestionMs": 60000,
  "questions": [{
    "id": "q1",
    "kind": "single",
    "label": "Style",
    "prompt": "Which error-handling style?",
    "context": "Optional markdown background",
    "options": [{
      "label": "Return errors",
      "description": "Explicit error returns",
      "recommended": true,
      "rationale": "Idiomatic Go",
      "example": "return nil, err",
      "exampleLanguage": "go",
      "source": "https://go.dev/blog/go1.13-errors"
    }]
  }]
}
```

`kind` is `single` | `multi` | `bool` | `input`. `options` is required (1-9) for `single`/`multi` and ignored for `bool`/`input`. `id` defaults to `q1`, `q2`, …

Result status is one of `answered`, `cancelled`, `aborted`, `timeout`, `error`.

## Layout

- `extensions/ask-user.ts`: the extension
- `package.json`: pi package manifest

## Credits

Several ideas (timeouts, question kinds, native fallback, events, result messaging) were inspired by [black-94/pi-ask-user](https://github.com/black-94/pi-ask-user) (MIT).
