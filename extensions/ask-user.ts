/**
 * pi-riddler: `ask_user` tool.
 *
 * Pi can ask one or more questions. Every question offers pre-written answers
 * AND an always-visible free-text field (unless `allowFreeText: false`).
 * Options can carry a recommendation (★), a rationale, a code example and a
 * source reference that are shown in a detail panel for the highlighted option.
 *
 * Question kinds: single (default) · multi · bool · input.
 * Extras: optional timeout with countdown (Alt+Q cancels it), abort-signal
 * support, validation, native dialog fallback (RPC), Herdr/ask:* events.
 *
 * Keys (list focus):  ↑/↓ option · Enter pick · Space toggle (multi) · Tab/typing → text
 *                     ←/→ question tabs · Ctrl+Enter submit all · Alt+Q stop countdown · Esc cancel
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

const MAX_QUESTIONS = 5;
const MAX_OPTIONS = 9;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;

type Kind = "single" | "multi" | "bool" | "input";
type Status = "answered" | "cancelled" | "aborted" | "timeout" | "error";

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
	kind: Kind;
	context?: string;
	options: Option[];
}
interface Answer {
	id: string;
	question: string;
	answer: string;
	kind: "option" | "multi" | "custom";
	optionIndex?: number;
	optionIndexes?: number[];
	note?: string;
}
interface Result {
	status: Status;
	answers: Answer[];
	warnings: string[];
	message?: string;
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
	id: Type.Optional(Type.String({ description: "Unique id for the question (default q1, q2…)" })),
	label: Type.Optional(Type.String({ description: "Short tab label (default Q1, Q2…)" })),
	prompt: Type.String({ description: "The question" }),
	kind: Type.Optional(
		Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("bool"), Type.Literal("input")], {
			description:
				"single (default, pick one), multi (pick several), bool (yes/no, options auto-generated) or input (free text only, no options)",
		}),
	),
	context: Type.Optional(Type.String({ description: "Background / findings shown under the question. Markdown." })),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description: `Pre-written answers (1-${MAX_OPTIONS}); required for single/multi, ignored for bool/input.`,
		}),
	),
});
const Params = Type.Object({
	questions: Type.Array(QuestionSchema, { description: `1-${MAX_QUESTIONS} questions` }),
	allowFreeText: Type.Optional(
		Type.Boolean({ description: "Default true. false hides the free-text field on single/multi/bool questions." }),
	),
	timeoutPerQuestionMs: Type.Optional(
		Type.Number({ description: "Optional timeout per question in ms (default: none). Result status is 'timeout' if it expires." }),
	),
});

function result(status: Status, answers: Answer[], warnings: string[] = [], message?: string): Result {
	return { status, answers, warnings, message };
}

/** Validate + normalize the request. Returns an error string or normalized questions. */
function normalize(params: {
	questions: Array<{ id?: string; label?: string; prompt: string; kind?: Kind; context?: string; options?: Option[] }>;
}): { error: string } | { questions: Question[]; warnings: string[] } {
	const warnings: string[] = [];
	const qs = params.questions;
	if (!Array.isArray(qs) || qs.length === 0) return { error: "No questions provided" };
	if (qs.length > MAX_QUESTIONS) return { error: `Too many questions (${qs.length}); max ${MAX_QUESTIONS}` };
	const ids = new Set<string>();
	const out: Question[] = [];
	for (let i = 0; i < qs.length; i++) {
		const q = qs[i];
		const id = q.id?.trim() || `q${i + 1}`;
		if (ids.has(id)) return { error: `Duplicate question id "${id}"` };
		ids.add(id);
		if (!q.prompt?.trim()) return { error: `Question "${id}" has an empty prompt` };
		const kind: Kind = q.kind ?? "single";
		let options: Option[] = [];
		if (kind === "bool") {
			options = [{ label: "True" }, { label: "False" }];
			if (q.options?.length) warnings.push(`Question "${id}": options ignored for kind "bool"`);
		} else if (kind === "input") {
			if (q.options?.length) warnings.push(`Question "${id}": options ignored for kind "input"`);
		} else {
			const seen = new Set<string>();
			for (const o of q.options ?? []) {
				const key = o.label?.trim().toLowerCase();
				if (!key) return { error: `Question "${id}" has an option with an empty label` };
				if (seen.has(key)) {
					warnings.push(`Question "${id}": duplicate option "${o.label}" dropped`);
					continue;
				}
				seen.add(key);
				options.push(o);
			}
			if (options.length === 0) return { error: `Question "${id}" (${kind}) needs at least one option` };
			if (options.length > MAX_OPTIONS) return { error: `Question "${id}" has ${options.length} options; max ${MAX_OPTIONS}` };
		}
		out.push({ id, label: q.label?.trim() || `Q${i + 1}`, prompt: q.prompt, kind, context: q.context, options });
	}
	return { questions: out, warnings };
}

const fmtTime = (ms: number) => {
	const s = Math.ceil(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Parse "1,3" / "1 3" (optionally "| note") into 0-based indexes; undefined if not a number list. */
function parseNumbers(text: string, max: number): { idx: number[]; note?: string } | undefined {
	const [nums, ...rest] = text.split("|");
	if (!/^[\d\s,]+$/.test(nums) || !nums.trim()) return undefined;
	const idx = [...new Set(nums.split(/[,\s]+/).filter(Boolean).map((n) => Number(n) - 1))];
	if (idx.some((i) => !Number.isInteger(i) || i < 0 || i >= max)) return undefined;
	return { idx: idx.sort((a, b) => a - b), note: rest.join("|").trim() || undefined };
}

type Ctx = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4];

interface RunOpts {
	allowFreeText: boolean;
	totalTimeoutMs: number; // 0 = none
	signal?: AbortSignal;
}

/** Native dialog fallback (RPC / no custom TUI): one dialog at a time. */
async function runNative(ctx: Ctx, questions: Question[], o: RunOpts): Promise<Result> {
	const deadline = o.totalTimeoutMs > 0 ? Date.now() + o.totalTimeoutMs : undefined;
	const answers: Answer[] = [];
	const outcome = (raw: string | undefined): Status | undefined => {
		if (o.signal?.aborted) return "aborted";
		if (deadline !== undefined && Date.now() >= deadline) return "timeout";
		return raw === undefined ? "cancelled" : undefined;
	};
	const opts = () => ({
		signal: o.signal,
		timeout: deadline === undefined ? undefined : Math.max(1, deadline - Date.now()),
	});
	const OTHER = "✎ Write my own answer";

	for (const q of questions) {
		const optLines = q.options.map(
			(op, i) => `  ${i + 1}. ${op.label}${op.recommended ? " ★" : ""}${op.description ? ` — ${op.description}` : ""}`,
		);
		const title = [`[${q.label}] ${q.prompt}`, q.context ?? "", ...(q.kind === "multi" ? optLines : [])]
			.filter(Boolean)
			.join("\n");
		const free = o.allowFreeText || q.kind === "input";
		const custom = (text: string) =>
			answers.push({ id: q.id, question: q.prompt, answer: text, kind: "custom" });

		if (q.kind === "input") {
			const raw = await ctx.ui.input(title, "type your answer", opts());
			const st = outcome(raw);
			if (st) return result(st, answers);
			if (!raw!.trim()) return result("cancelled", answers);
			custom(raw!.trim());
		} else if (q.kind === "multi") {
			let invalid = "";
			for (let attempt = 0; ; attempt++) {
				const raw = await ctx.ui.input(
					invalid + title,
					free ? "e.g. 1,3 or '1,3 | note' or free text" : "option numbers, e.g. 1,3",
					opts(),
				);
				const st = outcome(raw);
				if (st) return result(st, answers);
				const text = raw!.trim();
				const parsed = parseNumbers(text, q.options.length);
				if (parsed) {
					answers.push({
						id: q.id,
						question: q.prompt,
						answer: parsed.idx.map((i) => q.options[i].label).join(", "),
						kind: "multi",
						optionIndexes: parsed.idx.map((i) => i + 1),
						note: parsed.note,
					});
					break;
				}
				if (free && text) {
					custom(text);
					break;
				}
				if (attempt >= 2) return result("error", answers, [], `Invalid answer for "${q.id}"`);
				invalid = "⚠ Enter option numbers only.\n\n";
			}
		} else {
			// single / bool
			const labels = q.options.map((op, i) => `${i + 1}. ${op.label}${op.recommended ? " ★ recommended" : ""}`);
			const raw = await ctx.ui.select(title, free && q.kind === "single" ? [...labels, OTHER] : labels, opts());
			const st = outcome(raw);
			if (st) return result(st, answers);
			const i = labels.indexOf(raw!);
			if (i >= 0) {
				answers.push({ id: q.id, question: q.prompt, answer: q.options[i].label, kind: "option", optionIndex: i + 1 });
			} else {
				const text = await ctx.ui.input(`[${q.label}] ${q.prompt}`, "type your answer", opts());
				const st2 = outcome(text);
				if (st2) return result(st2, answers);
				custom(text!.trim());
			}
		}
	}
	return result("answered", answers);
}

/** Rich tabbed TUI. */
function runTui(ctx: Ctx, questions: Question[], o: RunOpts): Promise<Result> {
	return ctx.ui.custom<Result>((tui, theme, _kb, done) => {
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
		const many = questions.length > 1;
		const answers = new Map<string, Answer>();
		const cursor = new Map<string, number>(); // remembered highlight per question
		const drafts = new Map<string, string>(); // remembered text per question
		const checked = new Map<string, Set<number>>(); // multi selections
		let tab = 0;
		const initialFocus = (q: Question): "list" | "text" => (q.kind === "input" ? "text" : "list");
		let focus: "list" | "text" = initialFocus(questions[0]);
		let cache: string[] | undefined;
		let cacheW = 0;
		let finished = false;

		// ---- deadline / countdown ----
		let deadlineAt = o.totalTimeoutMs > 0 ? Date.now() + o.totalTimeoutMs : undefined;
		let timer: ReturnType<typeof setInterval> | undefined;
		const onAbort = () => finish("aborted");
		const finish = (status: Status) => {
			if (finished) return;
			finished = true;
			if (timer) clearInterval(timer);
			o.signal?.removeEventListener("abort", onAbort);
			done(result(status, [...answers.values()]));
		};
		const refresh = () => {
			cache = undefined;
			tui.requestRender();
		};
		if (deadlineAt !== undefined) {
			timer = setInterval(() => {
				if (deadlineAt !== undefined && Date.now() >= deadlineAt) finish("timeout");
				else refresh();
			}, 1000);
		}
		if (o.signal) {
			if (o.signal.aborted) queueMicrotask(onAbort);
			else o.signal.addEventListener("abort", onAbort, { once: true });
		}

		const recIdx = (q: Question) => Math.max(0, q.options.findIndex((x) => x.recommended));
		const cur = () => questions[tab];
		const idx = () => cursor.get(cur().id) ?? recIdx(cur());
		const canText = (q: Question) => q.kind === "input" || o.allowFreeText;
		const saveDraft = () => {
			if (tab < questions.length) drafts.set(cur().id, editor.getText());
		};
		const loadDraft = () => editor.setText(tab < questions.length ? (drafts.get(cur().id) ?? "") : "");
		const goTab = (n: number) => {
			saveDraft();
			tab = Math.max(0, Math.min(questions.length + (many ? 0 : -1), n));
			focus = tab < questions.length ? initialFocus(cur()) : "list";
			loadDraft();
			refresh();
		};
		const next = () => {
			if (!many) return finish("answered");
			goTab(tab + 1);
		};
		const checkedOf = (q: Question) => {
			let s = checked.get(q.id);
			if (!s) checked.set(q.id, (s = new Set()));
			return s;
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
			const note = editor.getText().trim();
			if (q.kind === "multi") {
				const sel = [...checkedOf(q)].sort((a, b) => a - b);
				if (sel.length === 0) {
					if (note && canText(q)) return editor.onSubmit?.(note);
					return;
				}
				answers.set(q.id, {
					id: q.id,
					question: q.prompt,
					answer: sel.map((i) => q.options[i].label).join(", "),
					kind: "multi",
					optionIndexes: sel.map((i) => i + 1),
					note: note || undefined,
				});
			} else {
				const i = idx();
				const op = q.options[i];
				if (!op) return;
				answers.set(q.id, {
					id: q.id,
					question: q.prompt,
					answer: op.label,
					kind: "option",
					optionIndex: i + 1,
					note: note || undefined,
				});
			}
			drafts.delete(q.id);
			editor.setText("");
			next();
		}

		function handleInput(data: string) {
			if (matchesKey(data, Key.alt("q"))) {
				if (deadlineAt !== undefined && Date.now() < deadlineAt) {
					deadlineAt = undefined;
					if (timer) clearInterval(timer);
					timer = undefined;
					refresh();
				}
				return;
			}
			if (matchesKey(data, Key.ctrl("enter"))) {
				if (!(many && tab < questions.length) || answers.size === questions.length) {
					if (answers.size === questions.length) finish("answered");
				}
				return;
			}
			const onSubmitTab = many && tab === questions.length;
			if (onSubmitTab) {
				if (matchesKey(data, Key.enter) && answers.size === questions.length) finish("answered");
				else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) goTab(tab - 1);
				else if (matchesKey(data, Key.escape)) finish("cancelled");
				return;
			}
			const q = cur();
			if (focus === "text") {
				if (matchesKey(data, Key.escape) && q.kind === "input") {
					finish("cancelled");
				} else if (matchesKey(data, Key.tab) || matchesKey(data, Key.escape)) {
					if (q.kind !== "input") focus = "list";
					else if (many) goTab(tab + 1);
				} else if (q.kind === "input" && many && (matchesKey(data, Key.shift("tab")))) {
					goTab(tab - 1);
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
			} else if (matchesKey(data, Key.space)) {
				if (q.kind === "multi") {
					const s = checkedOf(q);
					s.has(idx()) ? s.delete(idx()) : s.add(idx());
					refresh();
				} else pick();
			} else if (matchesKey(data, Key.enter)) {
				pick();
			} else if (matchesKey(data, Key.tab)) {
				if (canText(q)) {
					focus = "text";
					refresh();
				} else if (many) goTab(tab + 1);
			} else if (many && matchesKey(data, Key.right)) {
				goTab(tab + 1);
			} else if (many && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) {
				goTab(tab - 1);
			} else if (matchesKey(data, Key.escape)) {
				finish("cancelled");
			} else if (/^\d$/.test(data) && Number(data) >= 1 && Number(data) <= q.options.length) {
				cursor.set(q.id, Number(data) - 1);
				refresh();
			} else if (canText(q) && data.length === 1 && data > " " && data !== "\x7f") {
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
			const answerText = (a: Answer) => a.answer;

			rule();
			if (o.totalTimeoutMs > 0) {
				const left = deadlineAt === undefined ? undefined : Math.max(0, deadlineAt - Date.now());
				L.push(
					left === undefined
						? theme.fg("dim", " No timeout")
						: theme.fg(left < 10_000 ? "warning" : "dim", ` ⏱ ${fmtTime(left)} left • Alt+Q stop countdown`),
				);
			}
			if (many) {
				const tabs: string[] = [];
				for (let i = 0; i < questions.length; i++) {
					const done_ = answers.has(questions[i].id);
					const t = ` ${done_ ? "■" : "□"} ${questions[i].label} `;
					tabs.push(
						i === tab ? theme.bg("selectedBg", theme.fg("text", t)) : theme.fg(done_ ? "success" : "muted", t),
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

			if (many && tab === questions.length) {
				L.push(theme.fg("accent", theme.bold(" Review your answers")));
				L.push("");
				for (const q of questions) {
					const a = answers.get(q.id);
					wrap(
						" ",
						theme.fg("muted", q.label + ": ") +
							(a ? theme.fg("text", answerText(a)) : theme.fg("warning", "(unanswered)")),
					);
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
			const prev = answers.get(q.id);
			wrap(" ", theme.fg("text", theme.bold(q.prompt)));
			if (q.context) {
				L.push("");
				md(q.context);
			}
			L.push("");
			const isMulti = q.kind === "multi";
			const boxes = checkedOf(q);
			q.options.forEach((op, i) => {
				const isSel = i === sel;
				const active = isSel && focus === "list";
				const committed =
					prev &&
					(prev.kind === "option" ? prev.optionIndex === i + 1 : prev.kind === "multi" && prev.optionIndexes?.includes(i + 1));
				const mark = committed ? theme.fg("success", " ✓") : "";
				const star = op.recommended ? theme.fg("warning", " ★ recommended") : "";
				const prefix = active ? theme.fg("accent", " ❯ ") : isSel ? theme.fg("dim", " ❯ ") : "   ";
				const box = isMulti ? (boxes.has(i) ? theme.fg("success", "[x] ") : "[ ] ") : "";
				const label = `${i + 1}. ${box}${op.label}`;
				wrap(prefix, theme.fg(active ? "accent" : "text", label) + star + mark);
				if (op.description) wrap("      ", theme.fg("muted", op.description));
			});

			// detail panel for highlighted option
			const op = q.options[sel];
			if (op && (op.rationale || op.example || op.source)) {
				L.push("");
				L.push(theme.fg("dim", " ┌─ " + (op.recommended ? "Why I recommend this" : "About this option")));
				if (op.rationale) md(op.rationale);
				if (op.example) md("```" + (op.exampleLanguage ?? "") + "\n" + op.example.replace(/\n$/, "") + "\n```");
				if (op.source) wrap(" ", theme.fg("dim", "source: ") + theme.fg("accent", op.source));
				L.push(theme.fg("dim", " └─"));
			}

			// free-text field
			if (canText(q)) {
				if (q.options.length) L.push("");
				const hasText = editor.getText().length > 0;
				wrap(
					" ",
					theme.fg(focus === "text" ? "accent" : "muted", q.kind === "input" ? "Your answer" : "Or write your own answer") +
						theme.fg("dim", hasText && focus === "list" ? " (draft — Enter on an option attaches it as a note)" : ""),
				);
				editor.focused = focus === "text";
				for (const l of editor.render(Math.max(1, w - 2))) L.push(" " + l);
			}
			if (prev) wrap(" ", theme.fg("success", "Current answer: ") + theme.fg("text", answerText(prev)));
			L.push("");
			const submitHint = many ? " • Ctrl+Enter submit all" : "";
			L.push(
				theme.fg(
					"dim",
					focus === "list"
						? ` ↑↓/1-9 move • ${isMulti ? "Space toggle • Enter confirm" : "Enter pick"}${canText(q) ? " • Tab/type free text" : ""}${many ? " • ←→ questions" : ""}${submitHint} • Esc cancel`
						: ` Enter submit text as answer${q.kind === "input" ? "" : " • Tab/Esc back to options"}${many && q.kind === "input" ? " • Tab next question" : ""}`,
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
}

function describe(r: Result): string {
	const lines = r.answers.map((a) => {
		const how = a.kind === "custom" ? "wrote" : a.kind === "multi" ? `picked options ${a.optionIndexes?.join(",")}` : `picked option ${a.optionIndex}`;
		return `- [${a.id}] ${a.question}\n  User ${how}: ${a.answer}${a.note ? `\n  Additional note: ${a.note}` : ""}`;
	});
	const warn = r.warnings.length ? `\n\nWarnings:\n${r.warnings.map((w) => `- ${w}`).join("\n")}` : "";
	const partial = lines.length ? `\n\nAnswers given so far:\n${lines.join("\n")}` : "";
	switch (r.status) {
		case "answered":
			return lines.join("\n") + warn;
		case "cancelled":
			return `User cancelled the questions. Do not invent an answer; stop and ask what they want instead.${partial}${warn}`;
		case "aborted":
			return `The questions were aborted before the user answered. Do not invent an answer.${partial}${warn}`;
		case "timeout":
			return `The user did not answer in time (timeout). Do not invent an answer; proceed only with safe defaults or ask again later.${partial}${warn}`;
		case "error":
			return `Error: ${r.message ?? "unknown"}. The UI could not complete the request; ask the user the question yourself in ordinary text, including the options.${partial}${warn}`;
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user one or more clarifying questions interactively. Kinds: single (default), multi, bool, input. The user picks a pre-written answer or types free text (always available unless allowFreeText=false). Provide a recommended option with rationale, code example and source so the user can decide quickly.",
		promptSnippet: "ask_user: ask the user questions with recommended answers, evidence and free-text fallback",
		promptGuidelines: [
			"Use ask_user instead of guessing when requirements, behaviour or trade-offs are ambiguous.",
			"With ask_user, mark your best option as recommended and give rationale, a short code example and a source (file:line/URL) where you found the behaviour.",
			"With ask_user, batch related questions into one call (max 5); keep options mutually exclusive and concise. Use kind=multi for non-exclusive choices and kind=bool for yes/no.",
			"If ask_user is cancelled or times out, never invent the answer.",
		],
		parameters: Params,
		executionMode: "sequential",

		async execute(callId, params, signal, _onUpdate, ctx) {
			const reply = (r: Result) => ({ content: [{ type: "text" as const, text: describe(r) }], details: r });
			const norm = normalize(params as Parameters<typeof normalize>[0]);
			if ("error" in norm) {
				return {
					content: [{ type: "text" as const, text: `Invalid request: ${norm.error}. Fix the ask_user call.` }],
					details: result("error", [], [], `invalid_request: ${norm.error}`),
				};
			}
			if (ctx.mode !== "tui" && !ctx.hasUI) {
				return reply(result("error", [], norm.warnings, "No interactive UI available (non-interactive mode)"));
			}
			const perQ = Number(params.timeoutPerQuestionMs);
			const o: RunOpts = {
				allowFreeText: params.allowFreeText !== false,
				totalTimeoutMs: perQ > 0 ? Math.min(MAX_TIMEOUT_MS, perQ * norm.questions.length) : 0,
				signal,
			};

			pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response", callId });
			let r: Result;
			try {
				r = ctx.mode === "tui" ? await runTui(ctx, norm.questions, o) : await runNative(ctx, norm.questions, o);
			} catch (e) {
				r = result("error", [], [], e instanceof Error ? e.message : String(e));
			} finally {
				pi.events.emit("herdr:blocked", { active: false, callId });
			}
			r.warnings = [...norm.warnings, ...r.warnings];
			const route = ctx.mode === "tui" ? "custom" : "native";
			const ev = r.status === "answered" ? "answered" : r.status === "timeout" ? "timeout" : r.status === "error" ? "error" : "aborted";
			pi.events.emit(`ask:${ev}`, {
				callId,
				route,
				status: r.status,
				...(ev === "aborted" ? { cancelledReason: r.status === "aborted" ? "abort" : "user" } : {}),
			});
			return reply(r);
		},

		renderCall(args, theme) {
			const qs = Array.isArray(args.questions) ? args.questions : [];
			let t = theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", `${qs.length} question${qs.length === 1 ? "" : "s"}`);
			for (const q of qs) t += "\n" + theme.fg("dim", `  • ${q?.prompt ?? ""}`);
			return new Text(t, 0, 0);
		},

		renderResult(result_, _o, theme) {
			const d = result_.details as Result | undefined;
			if (!d) return new Text("", 0, 0);
			if (d.status !== "answered") {
				const label = { cancelled: "Cancelled", aborted: "Aborted", timeout: "Timed out", error: `Error: ${d.message ?? ""}` }[d.status];
				return new Text(theme.fg(d.status === "error" ? "error" : "warning", label), 0, 0);
			}
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
