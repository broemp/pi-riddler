/**
 * pi-riddler: `ask_user` tool.
 *
 * Pi can ask one or more questions. Every question offers pre-written answers
 * AND a always-visible free-text field. Options can carry a recommendation
 * (★), a rationale, a code example and a source reference that are shown in a
 * detail panel for the highlighted option.
 *
 * Keys (list focus):  ↑/↓ option · Enter pick (attaches note from text field)
 *                     Tab / typing → text field · ←/→ question tabs · Esc cancel
 * Keys (text focus):  Enter submit free text as the answer · Tab/Esc → list
 */

import { getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Option {
	label: string;
	description?: string;
	recommended?: boolean;
	rationale?: string;
	example?: string;
	exampleLanguage?: string;
	source?: string;
}
interface Question {
	id: string;
	label: string;
	prompt: string;
	context?: string;
	options: Option[];
}
interface Answer {
	id: string;
	question: string;
	answer: string;
	kind: "option" | "custom";
	optionIndex?: number;
	note?: string;
}
interface Result {
	answers: Answer[];
	cancelled: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String({ description: "Short answer text (this is what is returned if picked)" }),
	description: Type.Optional(Type.String({ description: "One-line explanation of the option" })),
	recommended: Type.Optional(Type.Boolean({ description: "Mark the option you recommend (ideally exactly one)" })),
	rationale: Type.Optional(
		Type.String({ description: "Why you recommend / think this fits. Markdown allowed. Cite evidence." }),
	),
	example: Type.Optional(Type.String({ description: "Code snippet supporting the option (no fences)" })),
	exampleLanguage: Type.Optional(Type.String({ description: "Language for the snippet, e.g. ts, go, python" })),
	source: Type.Optional(
		Type.String({ description: "Where you found the behaviour, e.g. src/auth.ts:42 or a URL" }),
	),
});
const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique id for the question" }),
	label: Type.Optional(Type.String({ description: "Short tab label (default Q1, Q2…)" })),
	prompt: Type.String({ description: "The question" }),
	context: Type.Optional(Type.String({ description: "Background / findings shown under the question. Markdown." })),
	options: Type.Array(OptionSchema, { description: "Pre-written answers. The user can always type free text too." }),
});
const Params = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "One or more questions" }),
});

function fail(msg: string) {
	return { content: [{ type: "text" as const, text: msg }], details: { answers: [], cancelled: true } as Result };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more clarifying questions interactively. The user picks a pre-written answer or types free text (both always available). Provide a recommended option with rationale, code example and source so the user can decide quickly.",
		promptSnippet: "ask_user: ask the user questions with recommended answers, evidence and free-text fallback",
		promptGuidelines: [
			"Use ask_user instead of guessing when requirements, behaviour or trade-offs are ambiguous.",
			"With ask_user, mark your best option as recommended and give rationale, a short code example and a source (file:line/URL) where you found the behaviour.",
			"With ask_user, batch related questions into one call; keep options mutually exclusive and concise.",
		],
		parameters: Params,
		executionMode: "sequential",

		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") return fail("Error: UI not available (non-interactive mode)");
			if (params.questions.length === 0) return fail("Error: No questions provided");
			const questions: Question[] = params.questions.map((q, i) => ({ ...q, label: q.label || `Q${i + 1}` }));
			const multi = questions.length > 1;

			const result = await ctx.ui.custom<Result>((tui, theme, _kb, done) => {
				const mdTheme = getMarkdownTheme();
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);
				const answers = new Map<string, Answer>();
				const cursor = new Map<string, number>(); // remembered highlight per question
				const drafts = new Map<string, string>(); // remembered text per question
				let tab = 0;
				let focus: "list" | "text" = "list";
				let cache: string[] | undefined;
				let cacheW = 0;

				const recIdx = (q: Question) => Math.max(0, q.options.findIndex((o) => o.recommended));
				const cur = () => questions[tab];
				const idx = () => cursor.get(cur().id) ?? recIdx(cur());
				const refresh = () => {
					cache = undefined;
					tui.requestRender();
				};
				const saveDraft = () => {
					if (tab < questions.length) drafts.set(cur().id, editor.getText());
				};
				const loadDraft = () => editor.setText(tab < questions.length ? (drafts.get(cur().id) ?? "") : "");
				const goTab = (n: number) => {
					saveDraft();
					tab = Math.max(0, Math.min(questions.length + (multi ? 0 : -1), n));
					focus = "list";
					loadDraft();
					refresh();
				};
				const finish = (cancelled: boolean) => done({ answers: [...answers.values()], cancelled });
				const next = () => {
					if (!multi) return finish(false);
					goTab(tab + 1);
				};

				editor.onSubmit = (value) => {
					const text = value.trim();
					if (!text) return;
					const q = cur();
					answers.set(q.id, { id: q.id, question: q.prompt, answer: text, kind: "custom" });
					drafts.delete(q.id);
					editor.setText("");
					next();
				};

				function pick() {
					const q = cur();
					const i = idx();
					const o = q.options[i];
					if (!o) return;
					const note = editor.getText().trim();
					answers.set(q.id, {
						id: q.id,
						question: q.prompt,
						answer: o.label,
						kind: "option",
						optionIndex: i + 1,
						note: note || undefined,
					});
					drafts.delete(q.id);
					editor.setText("");
					next();
				}

				function handleInput(data: string) {
					const onSubmitTab = multi && tab === questions.length;
					if (onSubmitTab) {
						if (matchesKey(data, Key.enter) && answers.size === questions.length) finish(false);
						else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) goTab(tab - 1);
						else if (matchesKey(data, Key.escape)) finish(true);
						return;
					}
					const q = cur();
					if (focus === "text") {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
							focus = "list";
						} else {
							editor.handleInput(data);
						}
						refresh();
						return;
					}
					if (matchesKey(data, Key.up)) {
						cursor.set(q.id, Math.max(0, idx() - 1));
						refresh();
					} else if (matchesKey(data, Key.down)) {
						cursor.set(q.id, Math.min(q.options.length - 1, idx() + 1));
						refresh();
					} else if (matchesKey(data, Key.enter)) {
						pick();
					} else if (matchesKey(data, Key.tab)) {
						focus = "text";
						refresh();
					} else if (multi && matchesKey(data, Key.right)) {
						goTab(tab + 1);
					} else if (multi && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) {
						goTab(tab - 1);
					} else if (matchesKey(data, Key.escape)) {
						finish(true);
					} else if (/^\d$/.test(data) && Number(data) >= 1 && Number(data) <= q.options.length) {
						cursor.set(q.id, Number(data) - 1);
						refresh();
					} else if (data.length === 1 && data >= " " && data !== "\x7f") {
						// start typing → jump into free text field
						focus = "text";
						editor.handleInput(data);
						refresh();
					}
				}

				function render(width: number): string[] {
					if (cache && cacheW === width) return cache;
					const w = Math.max(10, width);
					const L: string[] = [];
					const wrap = (prefix: string, text: string) => {
						const pw = visibleWidth(prefix);
						const parts = wrapTextWithAnsi(text, Math.max(1, w - pw));
						parts.forEach((p, i) => L.push((i === 0 ? prefix : " ".repeat(pw)) + p));
					};
					const md = (text: string) => {
						for (const l of new Markdown(text, 1, 0, mdTheme).render(w)) L.push(l);
					};
					const rule = () => L.push(theme.fg("accent", "─".repeat(w)));

					rule();
					if (multi) {
						const tabs: string[] = [];
						for (let i = 0; i < questions.length; i++) {
							const done_ = answers.has(questions[i].id);
							const t = ` ${done_ ? "■" : "□"} ${questions[i].label} `;
							tabs.push(
								i === tab
									? theme.bg("selectedBg", theme.fg("text", t))
									: theme.fg(done_ ? "success" : "muted", t),
							);
						}
						const ready = answers.size === questions.length;
						const st = ` ✓ Submit `;
						tabs.push(
							tab === questions.length
								? theme.bg("selectedBg", theme.fg("text", st))
								: theme.fg(ready ? "success" : "dim", st),
						);
						L.push(truncateToWidth(" " + tabs.join(" "), w));
						L.push("");
					}

					if (multi && tab === questions.length) {
						L.push(theme.fg("accent", theme.bold(" Review your answers")));
						L.push("");
						for (const q of questions) {
							const a = answers.get(q.id);
							wrap(" ", theme.fg("muted", q.label + ": ") + (a ? theme.fg("text", a.answer) : theme.fg("warning", "(unanswered)")));
							if (a?.note) wrap("    ", theme.fg("dim", "note: " + a.note));
						}
						L.push("");
						wrap(
							" ",
							answers.size === questions.length
								? theme.fg("success", "Enter to submit")
								: theme.fg("warning", "Answer all questions to submit"),
						);
						L.push(theme.fg("dim", " ←/Shift+Tab back • Esc cancel"));
						rule();
						cache = L;
						cacheW = width;
						return L;
					}

					const q = cur();
					const sel = idx();
					wrap(" ", theme.fg("text", theme.bold(q.prompt)));
					if (q.context) {
						L.push("");
						md(q.context);
					}
					L.push("");
					const prev = answers.get(q.id);
					q.options.forEach((o, i) => {
						const isSel = i === sel;
						const active = isSel && focus === "list";
						const mark = prev?.kind === "option" && prev.optionIndex === i + 1 ? theme.fg("success", " ✓") : "";
						const star = o.recommended ? theme.fg("warning", " ★ recommended") : "";
						const prefix = active ? theme.fg("accent", " ❯ ") : isSel ? theme.fg("dim", " ❯ ") : "   ";
						const label = `${i + 1}. ${o.label}`;
						wrap(prefix, theme.fg(active ? "accent" : "text", label) + star + mark);
						if (o.description) wrap("      ", theme.fg("muted", o.description));
					});

					// detail panel for highlighted option
					const o = q.options[sel];
					if (o && (o.rationale || o.example || o.source)) {
						L.push("");
						L.push(theme.fg("dim", " ┌─ " + (o.recommended ? "Why I recommend this" : "About this option")));
						if (o.rationale) md(o.rationale);
						if (o.example) md("```" + (o.exampleLanguage ?? "") + "\n" + o.example.replace(/\n$/, "") + "\n```");
						if (o.source) wrap(" ", theme.fg("dim", "source: ") + theme.fg("accent", o.source));
						L.push(theme.fg("dim", " └─"));
					}

					// always-visible free-text field
					L.push("");
					const hasText = editor.getText().length > 0;
					wrap(
						" ",
						theme.fg(focus === "text" ? "accent" : "muted", "Or write your own answer") +
							theme.fg("dim", hasText && focus === "list" ? " (draft — Enter on an option attaches it as a note)" : ""),
					);
					editor.focused = focus === "text";
					for (const l of editor.render(Math.max(1, w - 2))) L.push(" " + l);
					if (prev) wrap(" ", theme.fg("success", "Current answer: ") + theme.fg("text", prev.answer));
					L.push("");
					L.push(
						theme.fg(
							"dim",
							focus === "list"
								? " ↑↓/1-9 move • Enter pick • Tab/type free text" + (multi ? " • ←→ questions" : "") + " • Esc cancel"
								: " Enter submit text as answer • Tab/Esc back to options",
						),
					);
					rule();
					cache = L;
					cacheW = width;
					return L;
				}

				return {
					render,
					invalidate: () => {
						cache = undefined;
					},
					handleInput,
					get focused() {
						return focus === "text";
					},
					set focused(v: boolean) {
						editor.focused = v && focus === "text";
					},
				};
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questions." }],
					details: result,
				};
			}
			const lines = result.answers.map((a) => {
				const how = a.kind === "custom" ? "wrote" : `picked option ${a.optionIndex}`;
				return `- [${a.id}] ${a.question}\n  User ${how}: ${a.answer}${a.note ? `\n  Additional note: ${a.note}` : ""}`;
			});
			return { content: [{ type: "text", text: lines.join("\n") }], details: result };
		},

		renderCall(args, theme) {
			const qs = Array.isArray(args.questions) ? args.questions : [];
			let t = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`);
			for (const q of qs) t += "\n" + theme.fg("dim", `  • ${q?.prompt ?? ""}`);
			return new Text(t, 0, 0);
		},

		renderResult(result, _o, theme) {
			const d = result.details as Result | undefined;
			if (!d || d.cancelled) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const t = d.answers
				.map(
					(a) =>
						theme.fg("success", "✓ ") +
						theme.fg("accent", a.id + ": ") +
						(a.kind === "custom" ? theme.fg("muted", "(wrote) ") : "") +
						a.answer +
						(a.note ? theme.fg("dim", ` — ${a.note}`) : ""),
				)
				.join("\n");
			return new Text(t, 0, 0);
		},
	});
}
