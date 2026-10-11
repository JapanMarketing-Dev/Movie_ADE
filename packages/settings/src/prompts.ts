import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { solocutHome } from '@solocut/toolchain';
import { stripJsonComments } from './settings.js';

// Ready-made prompts (docs/13_prompts_and_autopilot.md). Defaults ⊕ ~/.solocut/prompts.json ⊕ <project>/.solocut/prompts.json.

const I18n = z.object({ ja: z.string().optional(), en: z.string().optional() });
const AgentRef = z.string().regex(/^(default|[a-z0-9][a-z0-9-]*|custom:[A-Za-z0-9_.-]+)$/);

export const PromptSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.object({ ja: z.string(), en: z.string() }),
  agent: AgentRef.default('default'),
  body: I18n,
  autopilot: z.boolean().optional(),
  hidden: z.boolean().optional(),
});
export type Prompt = z.infer<typeof PromptSchema>;

/** An entry in prompts.json: overrides a prompt by id, adds a new one, or hides one. */
export const PromptPatchSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  label: I18n.optional(),
  agent: AgentRef.optional(),
  body: I18n.optional(),
  autopilot: z.boolean().optional(),
  hidden: z.boolean().optional(),
});
export type PromptPatch = z.infer<typeof PromptPatchSchema>;

export const PromptsSchema = z.object({ $schema: z.string().optional(), prompts: z.array(PromptPatchSchema) });
export type PromptsFile = z.infer<typeof PromptsSchema>;

export const PROMPT_VARS = ['project', 'template', 'targets', 'latestFeedback', 'latestCheck', 'selection', 'date', 'archive'] as const;

const LOOP_JA =
  '`solocut next --json` を実行し、返ってきた step の `do` と `commands` に従って作業し、もう一度 `solocut next --json` を実行する、を繰り返してください。';
const LOOP_EN =
  'Run `solocut next --json`, do what its `do` and `commands` say, then run `solocut next --json` again; repeat.';

export const DEFAULT_PROMPTS: Prompt[] = [
  {
    id: 'finish',
    label: { ja: '動画を完成させて', en: 'Finish the video' },
    agent: 'default',
    autopilot: true,
    body: {
      ja: `このプロジェクト（{{project}}）の素材から、テンプレート {{template}} の手順に沿って、投稿できる状態の動画を3本完成させてください: YouTube の本編（16:9）、TikTok（9:16）、YouTube Shorts（9:16）。
${LOOP_JA} state が done になるまで止まらないでください。
- まず本編を仕上げ、チェックに合格したら \`solocut derive --target tiktok\` と \`--target youtube-shorts\` で縦型の2本を作り、テンプレートの prompts/vertical.md に沿って直します（各コマンドに \`--variant tiktok\` などを付けると、その版を操作できます）。
- サムネイルと投稿文（タイトル・説明文・タグ）は3本それぞれに作ります。仕上げは \`solocut render --final --all\`。
- 判定モデルの答えが中間のものは、一番確率の高い答えで進め、needsReview の印を付けて残してください。
- チェックの不合格は直して \`solocut check\` をやり直します。同じ項目を3回直しても通らなければ、.solocut/questions.md に書いて先へ進んでください。
- 同期の信頼度が低いときだけは待ってください（ずれた同期は全体を壊します）。待つ間に進められる手順を先に進めます。
- 投稿はしないでください。投稿は人が承認してからです。
最後に .solocut/handoff.md を更新し、やったことと確認してほしい点を3行で報告してください。`,
      en: `From this project's footage ({{project}}), finish three videos ready to publish, following template {{template}}: the YouTube main video (16:9), TikTok (9:16) and YouTube Shorts (9:16).
${LOOP_EN} Do not stop until state is done.
- Finish the main video first; once its checks pass, derive the vertical ones with \`solocut derive --target tiktok\` and \`--target youtube-shorts\` and refine them following the template's prompts/vertical.md (add \`--variant tiktok\` etc. to any command to work on that version).
- Make a thumbnail and post text (title, description, tags) for each of the three. Final renders: \`solocut render --final --all\`.
- When the decision model is unsure, take the most likely answer, mark it needsReview and move on.
- Fix failed checks and re-run \`solocut check\`. If the same item still fails after 3 fixes, note it in .solocut/questions.md and move on.
- Only wait when sync confidence is low (a wrong sync breaks everything); meanwhile continue with steps that do not depend on it.
- Do not publish. Publishing needs a human's approval.
Finally update .solocut/handoff.md and report what you did and what to review in 3 lines.`,
    },
  },
  {
    id: 'rough-cut',
    label: { ja: '粗カットだけ', en: 'Rough cut only' },
    agent: 'default',
    body: {
      ja: `テンプレート {{template}} の手順を rough-cut まで進めて、そこで止まってください。${LOOP_JA}
rough-cut では \`solocut propose cuts\` で候補を作り、テンプレートの prompts/rough-cut.md に沿って \`solocut edit\` で直します。
終わったら \`solocut render --preview\` を実行し、切った箇所の要約（何を何秒切ったか、迷った箇所）を報告してください。`,
      en: `Advance template {{template}} up to the rough-cut step and stop there. ${LOOP_EN}
In rough-cut, run \`solocut propose cuts\` and refine with \`solocut edit\` following the template's prompts/rough-cut.md.
Then run \`solocut render --preview\` and report what you cut (how much, and the uncertain spots).`,
    },
  },
  {
    id: 'fix-feedback',
    label: { ja: 'フィードバックに対応して', en: 'Address the feedback' },
    agent: 'default',
    body: {
      ja: `最新のフィードバック {{latestFeedback}} を読んで、指摘に1つずつ対応してください。
- 各指摘の対象（区間・字幕などの id）は \`solocut tl show <id>\` で確認し、直しは \`solocut edit\` で行います。編集の decided には feedbackRef を付けてください。
- 同じ種類の直しが今後も必要そうなら、テンプレートのプロンプトへの追記案を .solocut/handoff.md に書いてください。
終わったら \`solocut render --preview\` と \`solocut check\` を実行し、対応した指摘と、対応できなかった指摘（理由つき）を報告してください。`,
      en: `Read the latest feedback {{latestFeedback}} and address each item.
- Inspect each target (segment, caption ids…) with \`solocut tl show <id>\` and fix it with \`solocut edit\`; set feedbackRef in decided.
- If the same kind of fix will be needed again, propose an addition to the template prompts in .solocut/handoff.md.
Then run \`solocut render --preview\` and \`solocut check\`, and report what you fixed and what you could not (with reasons).`,
    },
  },
  {
    id: 'fix-checks',
    label: { ja: 'チェックを全部直して', en: 'Fix all checks' },
    agent: 'default',
    body: {
      ja: `最新のチェック結果 {{latestCheck}} の不合格をすべて直してください。
report.md の項目ごとに原因を確かめ、\`solocut edit\` で直し、\`solocut render --preview\` → \`solocut check\` を合格するまで繰り返します（同じ項目は最大3回まで。それでも通らなければ .solocut/questions.md に書いてください）。
直した内容を項目ごとに1行で報告してください。`,
      en: `Fix every failure in the latest check {{latestCheck}}.
For each item in report.md find the cause, fix it with \`solocut edit\`, then repeat \`solocut render --preview\` → \`solocut check\` until it passes (at most 3 tries per item; otherwise write it to .solocut/questions.md).
Report one line per fixed item.`,
    },
  },
  {
    id: 'captions-polish',
    label: { ja: '字幕を整えて', en: 'Polish the captions' },
    agent: 'default',
    body: {
      ja: `字幕を見直してください。対象: {{selection}}（空なら全体）。
- 誤字・誤変換（特に固有名詞と専門用語。timeline.json の meta.glossary を参照）を直す
- 1行の文字数と改行位置をテンプレートの prompts/captions.md に合わせる。文節の途中で改行しない
- 強調は1行に1語まで
- 言い換えは最小限にし、spoken（話した言葉）と意味がずれないようにする
直しは \`solocut edit updateCaption\` で行い、corrections に元の文字と理由を残してください。`,
      en: `Review the captions. Scope: {{selection}} (whole video if empty).
- Fix typos and mis-transcriptions (proper nouns and jargon; see meta.glossary in timeline.json)
- Match line length and breaks to the template's prompts/captions.md; never break inside a phrase
- At most one emphasized word per line
- Keep rewording minimal so the text never drifts from what was spoken
Use \`solocut edit updateCaption\` and record each change in corrections with a reason.`,
    },
  },
  {
    id: 'shorts',
    label: { ja: 'ショートを3本作って', en: 'Make 3 shorts' },
    agent: 'default',
    body: {
      ja: `この長尺から、縦型のショートを3本作ってください。
\`solocut tl summary\` で構成を把握し、単体で意味が通じて最初の2秒で引きのある区間（30〜60秒）を候補として5つ選び、理由を添えて .solocut/questions.md に書きます。
上位3つについて、出力先 {{targets}} の縦型の出力（range を指定した output）を \`solocut edit setOutput\` で作り、\`solocut render --final --target <target>\` で書き出してください。`,
      en: `Cut 3 vertical shorts from this long video.
Read the structure with \`solocut tl summary\`, pick 5 candidate ranges (30–60 s) that stand alone and hook in the first 2 seconds, and list them with reasons in .solocut/questions.md.
For the top 3, add vertical outputs (with range) for {{targets}} via \`solocut edit setOutput\` and render them with \`solocut render --final --target <target>\`.`,
    },
  },
  {
    id: 'thumbnail',
    label: { ja: 'サムネを3案作って', en: 'Make 3 thumbnails' },
    agent: 'codex',
    body: {
      ja: `サムネイルを3案作ってください。テンプレートの prompts/thumbnail.md の方向性に従います。
表情の良いフレームを \`solocut frame --at <フレーム>\` で取り出して候補にし（目を閉じていない・ブレていない・口の形が自然なもの）、文字は短く大きく（8〜12字）。
画像生成を使う場合は、元のフレームの人物の顔を変えないでください。できた3案を renders/thumbnails/ に置き、それぞれの狙いを1行で報告してください。`,
      en: `Make 3 thumbnail options following the template's prompts/thumbnail.md.
Grab expressive frames with \`solocut frame --at <frame>\` (eyes open, sharp, natural mouth), keep the text short and large (3–5 words).
If you use image generation, never alter the person's face. Put the 3 options in renders/thumbnails/ and report each one's intent in one line.`,
    },
  },
  {
    id: 'metadata',
    label: { ja: '投稿文を作って', en: 'Write the post text' },
    agent: 'default',
    body: {
      ja: `投稿用のテキストを作ってください。出力先: {{targets}}。
\`solocut tl summary\` の構成と meta.goal・meta.audience をもとに、タイトル候補5つ（32字以内、具体的な数字や結果を入れる）、説明文（最初の2行で内容が分かる）、チャプター（\`00:00 はじめに\` の形式。章の開始フレームから計算）、タグ10個、SNS の告知文（X 用 140字以内）を、出力先ごとに renders/<target>/metadata.md に書いてください。誇張や釣りの表現は使わないでください。`,
      en: `Write the publishing text for {{targets}}.
From \`solocut tl summary\`, meta.goal and meta.audience write: 5 title options (under 60 chars, concrete numbers or outcomes), a description whose first 2 lines say what the video delivers, chapters (\`00:00 Intro\` format, from chapter start frames), 10 tags and a social post (under 280 chars), into renders/<target>/metadata.md for each target. No clickbait.`,
    },
  },
  {
    id: 'publish',
    label: { ja: '投稿して', en: 'Publish' },
    agent: 'default',
    body: {
      ja: `投稿の準備をしてください。書き出し（renders/）、サムネイル、metadata.md がそろっているかを確認し、足りないものを報告します。
投稿そのものは、アプリの確認画面で人が承認してから行います。あなたは投稿しないでください。`,
      en: `Prepare for publishing: check that the render (renders/), thumbnail and metadata.md are all there and report anything missing.
Publishing itself happens after a human approves it in the app. Do not publish yourself.`,
    },
  },
  {
    id: 'announce',
    label: { ja: 'SNSで告知して', en: 'Announce on social' },
    agent: 'default',
    body: {
      ja: `X / Instagram / Threads / Facebook 向けの告知文を、それぞれの文字数と雰囲気に合わせて作り、renders/announce.md に書いてください。動画の要点を1つに絞り、URL を入れる場所を [URL] で示します。投稿は人が承認してから行います。`,
      en: `Write announcement posts for X / Instagram / Threads / Facebook, each fitted to its length and tone, into renders/announce.md. Focus on one takeaway and mark the link position with [URL]. Posting happens after a human approves it.`,
    },
  },
  {
    id: 'english',
    label: { ja: '英語字幕も作って', en: 'Add English subtitles' },
    agent: 'default',
    body: {
      ja: `英語の字幕と、英語のタイトル・説明文を作ってください。
字幕は日本語の字幕と同じタイミングで、意味を優先して自然な英語にします（直訳しない。専門用語は英語圏で一般的な表記に）。renders/<target>/subtitles.en.srt に書き、タイトルと説明文は renders/<target>/metadata.en.md に書いてください。`,
      en: `Create English subtitles and an English title and description.
Keep the same timing as the Japanese captions; translate for meaning, not word by word, using the usual English terms for jargon. Write renders/<target>/subtitles.en.srt and renders/<target>/metadata.en.md.`,
    },
  },
  {
    id: 'same-as-last',
    label: { ja: '前回と同じ作りにして', en: 'Same as last time' },
    agent: 'default',
    body: {
      ja: `直前に作った回を参考にして編集してください。\`solocut past list --limit 1 --json\` で直前の回を見つけ、\`solocut past show <id>\` で概要と統計を読みます。
\`solocut edit setMeta\` で meta.references にその回を登録し（use: pacing, scenes, captions, sfx）、カットのテンポ（平均の区間の長さ・切った割合）、シーンの使い方、字幕、効果音の頻度を合わせながら ${LOOP_JA}`,
      en: `Edit this video like the previous one. Find it with \`solocut past list --limit 1 --json\` and read \`solocut past show <id>\`.
Register it in meta.references via \`solocut edit setMeta\` (use: pacing, scenes, captions, sfx) and match its pacing (average segment length, cut ratio), scene usage, captions and sfx frequency while you work. ${LOOP_EN}`,
    },
  },
  {
    id: 'like-past',
    label: { ja: '過去の動画を参考に作って', en: 'Edit like a past video' },
    agent: 'default',
    body: {
      ja: `過去の回 {{archive}} を参考にして編集してください（空なら \`solocut past search\` で近い回を探し、候補を3つ挙げてから一番近いものを選びます）。
\`solocut past show <id>\` で概要と統計を、必要な部分だけ \`solocut past timeline <id>\` で読みます。\`solocut edit setMeta\` で meta.references に登録し、その回のテンポ、シーン、字幕、効果音、サムネイルの作りに合わせて ${LOOP_JA}
参考の回と違う作りにした箇所は、理由を decided.reason に書いてください。`,
      en: `Use past video {{archive}} as the reference (if empty, find close ones with \`solocut past search\`, list 3 and pick the closest).
Read \`solocut past show <id>\` and only the parts you need of \`solocut past timeline <id>\`. Register it in meta.references via \`solocut edit setMeta\` and match its pacing, scenes, captions, sfx and thumbnail style. ${LOOP_EN}
Where you deliberately differ, say why in decided.reason.`,
    },
  },
  {
    id: 'compare-past',
    label: { ja: '過去の回と比べて', en: 'Compare with a past video' },
    agent: 'default',
    body: {
      ja: `今の動画と過去の回 {{archive}} を比べてください（空なら直前の回）。
\`solocut past show <id> --json\` の統計と、今のプロジェクトの \`solocut tl summary --json\` を比べ、テンポ（平均の区間の長さ・切った割合）、字幕の量と強調、効果音とズームの頻度、構成（章の数と長さ）の違いを表にし、改善点を3つ、優先度の高い順に報告してください。編集はしないでください。`,
      en: `Compare the current video with past video {{archive}} (the previous one if empty).
Compare the stats from \`solocut past show <id> --json\` with \`solocut tl summary --json\`: pacing (average segment length, cut ratio), caption volume and emphasis, sfx and zoom frequency, and structure (chapter count and length). Report a table of differences and the top 3 improvements by priority. Do not edit.`,
    },
  },
  {
    id: 'learn',
    label: { ja: '今回の直しをテンプレートに反映して', en: 'Learn from this edit' },
    agent: 'default',
    body: {
      ja: `今回のフィードバック（feedback/）と人の判断（.solocut/history.jsonl で by が human のもの）を見て、繰り返し出た直しを探してください。
次回から最初に反映されるよう、テンプレートの rules.md と prompts/*.md への追記案を、具体的な文で3つまで作り、差分として示してください。人が承認するまでテンプレートのファイルは書き換えないでください。`,
      en: `Review this project's feedback (feedback/) and human decisions (entries with by=human in .solocut/history.jsonl) and find repeated fixes.
Propose up to 3 concrete additions to the template's rules.md and prompts/*.md, shown as diffs, so they apply from the start next time. Do not modify the template until a human approves.`,
    },
  },
  {
    id: 'bench-apply',
    label: { ja: 'ベンチマークを取り込んで', en: 'Apply a benchmark' },
    agent: 'default',
    body: {
      ja: `選んだスタイルプロファイル {{selection}} をテンプレートに取り込む差分を作ってください。字幕のスタイル、カットのテンポ、効果音の頻度を、template.yaml と prompts/*.md にどう反映するかを示し、人が承認してから書き換えます。`,
      en: `Draft the changes that bring style profile {{selection}} into the template: caption style, cut pacing and sfx frequency in template.yaml and prompts/*.md. Apply them only after a human approves.`,
    },
  },
];

export interface PromptsLoadResult { prompts: Prompt[]; errors: { file: string; message: string }[] }

function readPromptsFile(path: string): { patches: PromptPatch[]; error?: string } {
  if (!existsSync(path)) return { patches: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')));
  } catch (e) {
    return { patches: [], error: `invalid JSON: ${(e as Error).message}` };
  }
  const r = PromptsSchema.safeParse(raw);
  if (!r.success) return { patches: [], error: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') };
  return { patches: r.data.prompts };
}

/** Apply prompts.json patches to a list: override fields by id, add new prompts, hide with `hidden: true`. */
export function mergePrompts(base: Prompt[], patches: PromptPatch[], errors: string[] = []): Prompt[] {
  const out = base.map((p) => ({ ...p, label: { ...p.label }, body: { ...p.body } }));
  for (const patch of patches) {
    const cur = out.find((p) => p.id === patch.id);
    if (cur) {
      if (patch.label) cur.label = { ...cur.label, ...stripUndef(patch.label) };
      if (patch.body) cur.body = { ...cur.body, ...stripUndef(patch.body) };
      if (patch.agent !== undefined) cur.agent = patch.agent;
      if (patch.autopilot !== undefined) cur.autopilot = patch.autopilot;
      if (patch.hidden !== undefined) cur.hidden = patch.hidden;
      continue;
    }
    const added = PromptSchema.safeParse({ ...patch, label: patch.label, body: patch.body ?? {} });
    if (!added.success || !(patch.body?.ja || patch.body?.en) || !patch.label?.ja || !patch.label?.en) {
      errors.push(`prompt "${patch.id}" is new and needs label.ja, label.en and a body`);
      continue;
    }
    out.push(added.data);
  }
  return out;
}

function stripUndef<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function loadPromptsWithErrors(projectDir?: string, o: { includeHidden?: boolean } = {}): PromptsLoadResult {
  const errors: { file: string; message: string }[] = [];
  let list = DEFAULT_PROMPTS;
  const files = [join(solocutHome(), 'prompts.json')];
  if (projectDir) files.push(join(projectDir, '.solocut', 'prompts.json'));
  for (const file of files) {
    const { patches, error } = readPromptsFile(file);
    if (error) errors.push({ file, message: error });
    const mergeErrors: string[] = [];
    list = mergePrompts(list, patches, mergeErrors);
    for (const m of mergeErrors) errors.push({ file, message: m });
  }
  return { prompts: o.includeHidden ? list : list.filter((p) => !p.hidden), errors };
}

/** default ⊕ ~/.solocut/prompts.json ⊕ <project>/.solocut/prompts.json, hidden ones removed. */
export function loadPrompts(projectDir?: string, o: { includeHidden?: boolean } = {}): Prompt[] {
  return loadPromptsWithErrors(projectDir, o).prompts;
}

/** Body in `lang` (falls back to the other language) with {{vars}} filled. Unknown or missing vars become "". */
export function renderPrompt(p: Prompt, vars: Record<string, string>, lang: 'ja' | 'en'): string {
  const body = p.body[lang] ?? p.body[lang === 'ja' ? 'en' : 'ja'] ?? '';
  const all: Record<string, string> = { date: new Date().toISOString().slice(0, 10), ...vars };
  return body.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => all[name] ?? '');
}

export function promptsJsonSchema(): object {
  return { $id: 'https://solocut.app/schema/prompts.v1.json', ...(z.toJSONSchema(PromptsSchema, { io: 'input' }) as object) };
}
