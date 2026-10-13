# pi-riddler

A [pi](https://pi.dev/) extension that adds an `ask_user` tool. The agent asks one or more questions. You answer with a pre-written option **or** free text, and both are always available.

## Features

- Several questions per call, shown as tabs
- Options can carry a ★ recommendation, a rationale, a code example (with language) and a source reference. These appear in a detail panel for the highlighted option.
- Free-text field is always visible. Text typed there is attached as a note when you pick an option.

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
| Enter | Pick option (text field content becomes a note) |
| Tab, or just type | Switch to free-text field; Enter submits it |
| ← / → | Switch question |
| Esc | Cancel |

## Tool parameters

```json
{
  "questions": [{
    "id": "q1",
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

## Layout

- `extensions/ask-user.ts`: the extension
- `package.json`: pi package manifest
