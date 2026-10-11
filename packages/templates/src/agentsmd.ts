import type { Template } from './load.js';
import { derivedTargets, expandPipeline, splitStep, stepText } from './next.js';

// AGENTS.md generator (docs/04 「エージェントへの指示書」). CLAUDE.md only contains `@AGENTS.md`.

export interface AgentsMdProject { dir: string; title: string; lang: 'ja' | 'en' }

const CLI_JA: [string, string][] = [
  ['solocut status --json', '手順の進み具合とプロジェクトの概要'],
  ['solocut next --json', '次にやること（1つだけ）。迷ったらまずこれ'],
  ['solocut ingest --json', '収録したテイク（media/takes/）を素材として登録する'],
  ['solocut takes --json', 'テイクと取り込んだ素材の一覧'],
  ['solocut import <file> --kind camera --role front', '別撮りの素材を取り込む'],
  ['solocut sync --json', 'トラック間の同期'],
  ['solocut transcribe --json', '文字起こし（derived/transcripts/main.json）'],
  ['solocut analyze --json', '無音・ラウドネスの解析（derived/analysis/）'],
  ['solocut propose cuts --json', 'カットの候補を作って区間にする（--dry-run で書き込まない）'],
  ['solocut tl summary --json', '構成・区間の数・未解決の一覧。まず読むもの'],
  ['solocut tl show <id> --json', '1つの要素とその周り'],
  ['solocut tl range 00:01:00-00:02:00 --json', 'その時間帯にある要素'],
  ['solocut tl query "segments[role=demo]" --json', '条件で絞り込む'],
  ['solocut tl why <id> --json', 'その要素の decided と関係する履歴'],
  ['solocut edit <op> --<field> <value> --reason "<なぜ>"', '編集操作を1つ適用する'],
  ['solocut edit --ops ops.json', '複数の操作をまとめて適用する（失敗したら何も変わらない）'],
  ['solocut undo / solocut redo / solocut history', '取り消し・やり直し・履歴'],
  ['solocut validate --json', 'timeline.json の検証（直接書き換えたら必ず実行）'],
  ['solocut captions build --json', '字幕を作る（captions/main.ass と main.srt も出す）'],
  ['solocut render --preview --json', 'プレビューを書き出す（変わった区間だけ作り直す）'],
  ['solocut render --final --target youtube --json', '本番の書き出し'],
  ['solocut frame --at <フレーム|00:01:02:03> --json', '1フレームの静止画'],
  ['solocut check --json', '機械的チェック（checks/<run>/report.md）'],
  ['solocut step <step> done|skipped --note "<メモ>"', '手作業の手順を終えた印を付ける'],
  ['solocut past list|search|show|timeline', '過去の動画（アーカイブ）を参照する'],
  ['solocut config get|set|schema', '設定の読み書き'],
  ['solocut prompts list|show <id>', '用意済みのプロンプト'],
  ['solocut doctor --json', '環境の診断（ツール、エージェント）'],
];

const CLI_EN: [string, string][] = [
  ['solocut status --json', 'Step progress and project overview'],
  ['solocut next --json', 'The one next thing to do. Start here when unsure'],
  ['solocut ingest --json', 'Register recorded takes (media/takes/) as sources'],
  ['solocut takes --json', 'Recorded takes and imported media'],
  ['solocut import <file> --kind camera --role front', 'Import separately recorded media'],
  ['solocut sync --json', 'Sync the tracks'],
  ['solocut transcribe --json', 'Transcribe (derived/transcripts/main.json)'],
  ['solocut analyze --json', 'Silence and loudness analysis (derived/analysis/)'],
  ['solocut propose cuts --json', 'Build segments from cut candidates (--dry-run writes nothing)'],
  ['solocut tl summary --json', 'Structure, segment count, open items. Read this first'],
  ['solocut tl show <id> --json', 'One element and its surroundings'],
  ['solocut tl range 00:01:00-00:02:00 --json', 'Everything in a time range'],
  ['solocut tl query "segments[role=demo]" --json', 'Filter elements'],
  ['solocut tl why <id> --json', 'The decided record and related history of an element'],
  ['solocut edit <op> --<field> <value> --reason "<why>"', 'Apply one edit operation'],
  ['solocut edit --ops ops.json', 'Apply several operations atomically'],
  ['solocut undo / solocut redo / solocut history', 'Undo, redo, history'],
  ['solocut validate --json', 'Validate timeline.json (always after editing it by hand)'],
  ['solocut captions build --json', 'Build captions (also captions/main.ass and main.srt)'],
  ['solocut render --preview --json', 'Render the preview (only changed chunks are re-rendered)'],
  ['solocut render --final --target youtube --json', 'Final render'],
  ['solocut frame --at <frame|00:01:02:03> --json', 'A still of one frame'],
  ['solocut check --json', 'Machine checks (checks/<run>/report.md)'],
  ['solocut step <step> done|skipped --note "<note>"', 'Mark a manual step finished'],
  ['solocut past list|search|show|timeline', 'Look at past videos (archive)'],
  ['solocut config get|set|schema', 'Read and change settings'],
  ['solocut prompts list|show <id>', 'Ready-made prompts'],
  ['solocut doctor --json', 'Environment diagnosis (tools, agents)'],
];

const NEXT_EXAMPLE = `{
  "ok": true,
  "step": "rough-cut",
  "state": "needs-human",
  "why": "…",
  "do": "…",
  "commands": ["solocut captions build --json"],
  "blocking": ["seg_14", "seg_22"]
}`;

const EDIT_EXAMPLE = `solocut edit removeSegment --id seg_12 --reason "言い直しの前半。後のテイクのほうが明瞭"
solocut edit trimSegment --id seg_03 --to 1840 --reason "語尾の後の間を詰める"
solocut edit --ops '[{"op":"setCamera","id":"seg_05","camera":"cam_close","decided":{"by":"agent","reason":"結論の直前で寄る"}}]'`;

const EDIT_EXAMPLE_EN = `solocut edit removeSegment --id seg_12 --reason "First half of a retake; the later take is clearer"
solocut edit trimSegment --id seg_03 --to 1840 --reason "Tighten the pause after the sentence"
solocut edit --ops '[{"op":"setCamera","id":"seg_05","camera":"cam_close","decided":{"by":"agent","reason":"Punch in before the conclusion"}}]'`;

function table(rows: [string, string][], head: [string, string]): string {
  return [`| ${head[0]} | ${head[1]} |`, '|---|---|', ...rows.map(([c, d]) => `| \`${c.replace(/\|/g, '\\|')}\` | ${d} |`)].join('\n');
}

export function generateAgentsMd(t: Template, project: AgentsMdProject): string {
  const ja = project.lang === 'ja';
  const name = ja ? t.name.ja : t.name.en;
  const variants = derivedTargets(t);
  const steps = expandPipeline(t)
    .map((s, i) => {
      const txt = stepText(s, project.lang, variants);
      const promptKey = splitStep(s).base === 'derive' ? 'vertical' : s;
      const prompt = t.promptFiles[promptKey] ? (ja ? `（\`${t.promptFiles[promptKey]}\` に従う）` : ` (follow \`${t.promptFiles[promptKey]}\`)`) : '';
      return `${i + 1}. **${s}** — ${txt.do}${prompt}`;
    })
    .join('\n');
  const prompts = Object.keys(t.promptFiles).length
    ? Object.entries(t.promptFiles).map(([k, p]) => `- \`${k}\`: \`${p}\``).join('\n')
    : ja ? '（なし）' : '(none)';
  const rules = t.rules.trim() || (ja ? '（テンプレートに rules.md はありません）' : '(the template has no rules.md)');

  if (ja) {
    return `<!-- solocut が自動生成したファイルです。テンプレートを変えると作り直されます。手で直すなら rules.md と prompts/ を直してください。 -->
# ${project.title} — エージェントへの指示書

## 役割

あなたはこのプロジェクトの動画編集者です。テンプレート **${name}**（\`${t.id}\` 版 ${t.version}）の手順に従って、撮影した素材から動画を仕上げます。
編集の正本は \`timeline.json\` です。すべての編集は \`solocut\` CLI で行います。

- 種類: ${t.kind === 'tech' ? '技術動画' : '語り動画'}
- 出力先: ${t.targets.join(', ')}
- キャンバス: ${t.canvas.width}×${t.canvas.height}, ${t.canvas.fps.num}/${t.canvas.fps.den} fps

## 最初にすること

\`\`\`sh
solocut status --json
solocut next --json
\`\`\`

\`.solocut/handoff.md\` があれば先に読んでください（前のエージェントからの引き継ぎです）。
あとは \`solocut next --json\` の \`do\` と \`commands\` に従い、終わったらもう一度 \`solocut next --json\` を実行する、を \`"state": "done"\` になるまで繰り返します。

## 守ること

- \`media/\` の中は変更しない（元の素材は読み取り専用）
- 編集は \`solocut edit\` で行う。\`timeline.json\` を直接編集したら、必ず \`solocut validate\` を実行する
- 編集には必ず理由を付ける（\`--reason\`）。理由は「なぜそうしたか」を1文で
- 手順の合格条件を満たすまで、次の手順に進まない（\`solocut next\` が判断する）
- 迷ったら、判定モデルの結果と下の編集方針に従う。それでも決まらなければ \`.solocut/questions.md\` に質問を書いて人に聞き、待たずに進められる手順を先に進める
- 投稿はしない。投稿は人が承認してから
- 長い出力は読まない。\`solocut tl summary\` → \`tl show\` / \`tl range\` の順に必要な部分だけ読む

## 手順（${t.id}）

${steps}

## 編集方針（rules.md）

${rules}

## 手順ごとのプロンプト

${prompts}

## CLI の使い方

すべてのコマンドに \`--json\` を付けると機械向けの出力になります。失敗したときは \`{"ok": false, "error": {"code": "…", "message": "…"}}\` を返し、終了コードは 1 です。

${table(CLI_JA, ['コマンド', '内容'])}

\`solocut next --json\` の出力例:

\`\`\`json
${NEXT_EXAMPLE}
\`\`\`

編集の例:

\`\`\`sh
${EDIT_EXAMPLE}
\`\`\`

## 終わったとき

\`.solocut/handoff.md\` に次の3つを書いてください。エージェントが替わっても、ここから続けられるようにします。

1. やったこと
2. 残っていること（要確認の項目、直せなかったチェック）
3. 次の一手（次に実行するコマンド）
`;
  }

  return `<!-- Generated by solocut. Regenerated when the template changes. Edit rules.md and prompts/ instead. -->
# ${project.title} — Instructions for the agent

## Role

You are the video editor of this project. Follow the steps of template **${name}** (\`${t.id}\` version ${t.version}) to turn the recorded media into a finished video.
\`timeline.json\` is the source of truth. Make every edit through the \`solocut\` CLI.

- Kind: ${t.kind === 'tech' ? 'tech video' : 'talking-head video'}
- Targets: ${t.targets.join(', ')}
- Canvas: ${t.canvas.width}×${t.canvas.height}, ${t.canvas.fps.num}/${t.canvas.fps.den} fps

## First

\`\`\`sh
solocut status --json
solocut next --json
\`\`\`

If \`.solocut/handoff.md\` exists, read it first (a handoff from the previous agent).
Then follow \`do\` and \`commands\` from \`solocut next --json\`, run \`solocut next --json\` again, and repeat until \`"state": "done"\`.

## Rules

- Never modify anything in \`media/\` (original media is read-only)
- Edit with \`solocut edit\`. If you edit \`timeline.json\` directly, always run \`solocut validate\`
- Every edit needs a reason (\`--reason\`): one sentence on why
- Do not move on until the step's pass condition is met (\`solocut next\` decides)
- When unsure, follow the decision model and the editing policy below. If still undecided, write the question to \`.solocut/questions.md\` and continue with steps that do not depend on it
- Never publish. Publishing needs a human's approval
- Do not read huge outputs: \`solocut tl summary\` first, then \`tl show\` / \`tl range\` for the parts you need

## Steps (${t.id})

${steps}

## Editing policy (rules.md)

${rules}

## Prompts per step

${prompts}

## CLI

Add \`--json\` to any command for machine output. Failures return \`{"ok": false, "error": {"code": "…", "message": "…"}}\` with exit code 1.

${table(CLI_EN, ['Command', 'What it does'])}

\`solocut next --json\` example:

\`\`\`json
${NEXT_EXAMPLE}
\`\`\`

Edit examples:

\`\`\`sh
${EDIT_EXAMPLE_EN}
\`\`\`

## When you finish

Write these three things to \`.solocut/handoff.md\` so any agent can continue from there:

1. What you did
2. What remains (open review items, checks you could not fix)
3. The next move (the next command to run)
`;
}

export const CLAUDE_MD = '@AGENTS.md\n';
