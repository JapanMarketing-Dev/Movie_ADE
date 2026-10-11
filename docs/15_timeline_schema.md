# 15. timeline.json — 情報量と型

最終更新: 2026-10-11

## なぜ timeline.json が一番大事か

エージェントは、毎回まっさらな状態で作業を始める。前回の作業を覚えていない。だから、**`timeline.json` を読めば、その動画の中身、作り、決めた理由、残っている問題がすべて分かる**ようにしておく。情報が足りないと、エージェントは推測で編集し、仕上がりがぶれる。

設計の原則は2つ。

1. **情報量を最大にする**: 「何を」だけでなく、「なぜ」「誰が」「どれくらいの確信で」「どの素材を」「どのライセンスで」「チェックの結果は」まで持つ
2. **すべてに型を付ける**: TypeScript の型を正本にして、JSON Schema を自動生成する。曖昧な自由形式のフィールドは作らない。種類で分かれるものは判別可能なユニオン（`kind` で分岐）にする

## 型の正本と検証

- 型は `packages/core/src/timeline/` に TypeScript（zod）で書く。ここから `timeline.schema.json` を生成し、`solocut.app/schema/timeline.v1.json` で公開する
- `solocut validate` は、スキーマに加えて**意味の検証**も行う（参照先の id が存在するか、区間が重なっていないか、フレームが素材の範囲内か、ライセンスの条件を満たしているか）
- エージェントが直接書き換えた場合も、検証に通らないものは読み込まない（最後に正しかった状態を保つ）
- スキーマにはバージョン（`schema: 1`）を持たせ、変更時は移行関数（`migrate/v1-to-v2.ts`）を必ず書く

## 全体の構造

```ts
interface Timeline {
  schema: 1;
  meta: Meta;                       // 動画の目的・対象・テンプレート
  canvas: Canvas;                   // 解像度、fps、色空間
  sources: Record<SourceId, Source>;// 素材（収録・取り込み・素材集）
  transcript: TranscriptRef;        // 文字起こし（単語単位）への参照と要約
  outline: Chapter[];               // 構成（章、要点）
  segments: Segment[];              // 本編の並び（カットの結果）
  scenes: Scene[];                  // シーンのパターン（型）を使った挿入
  captions: Caption[];              // 字幕
  overlays: Overlay[];              // テロップ、画像、ロゴ、図
  audio: AudioPlan;                 // 話し声の処理、BGM、効果音
  masks: Mask[];                    // モザイク
  markers: Marker[];                // 章、撮影時の目印、メモ
  outputs: Output[];                // 出力先ごとの設定と状態
  review: ReviewState;              // チェック、要確認、フィードバックの状態
  provenance: ProvenanceIndex;      // 誰が・いつ・なぜ（history.jsonl への索引）
}
```

### 共通の型

```ts
type Frame = number & { __unit: 'timelineFrame' };  // タイムラインのフレーム番号（整数）
type SourceFrame = number & { __unit: 'sourceFrame' };
type Id<K extends string> = `${K}_${string}`;        // 例: "seg_01J9…"、"cap_…"。種類が id から分かる

interface Decided {                 // 判断を伴うものすべてに付ける
  by: 'human' | 'agent' | 'decision-model' | 'rule' | 'template';
  agent?: string;                   // claude / codex / …
  reason: string;                   // なぜそうしたか（1文）
  confidence?: number;              // 0〜1（判定モデル・ルールの場合）
  ruleRef?: string;                 // テンプレートの規則やプロンプトの該当箇所（例: "prompts/multicam.md#2"）
  feedbackRef?: Id<'fb'>;           // 元になったフィードバック
  needsReview?: boolean;            // 要確認の印
}
```

### meta — 動画の目的

```ts
interface Meta {
  title: string;                    // 仮題
  kind: 'tech' | 'talk';            // 技術動画 / 語り動画
  template: { id: string; version: string };
  audience: string;                 // 例: "Claude Code を使い始めたエンジニア"
  goal: string;                     // 例: "設定の3つのコツを伝え、チャンネル登録につなげる"
  language: 'ja' | 'en';
  targets: ('youtube' | 'youtube-shorts' | 'tiktok' | 'instagram-reels')[];
  glossary: { term: string; reading?: string; note?: string }[];  // 用語集（字幕の誤変換の修正に使う）
}
```

エージェントは `goal` と `audience` を見て、何を残し何を切るかを判断する。

### sources — 素材

```ts
type Source =
  | { kind: 'screen';  path: string; take: Id<'take'>; display: string; fps: Rational; size: Size; offset: SourceFrame; cursorLog?: string; keyLog?: string }
  | { kind: 'camera';  path: string; take?: Id<'take'>; role: 'front' | 'close' | 'wide' | 'side' | 'other'; fps: Rational; size: Size;
      offset: SourceFrame; drift?: number; sync?: { method: 'clock' | 'xcorr' | 'manual'; confidence: number } }
  | { kind: 'mic';     path: string; take?: Id<'take'>; sampleRate: number; offset: SourceFrame }
  | { kind: 'asset';   path: string; assetId: string; license: LicenseRef };   // 素材集の画像・音・アニメーション

interface LicenseRef {
  id: string;                       // 例: "CC0-1.0"、"irasutoya"、"OtoLogic-CC-BY-4.0"
  credit?: string;                  // 表記が必要な場合の文言
  limitKey?: string;                // 点数制限を数えるキー（例: いらすとやは1作品20点まで）
  sourceUrl?: string;
}
```

### transcript と outline — 何を話しているか

```ts
interface TranscriptRef {
  path: 'derived/transcripts/main.json';   // 単語単位: { w, start, end, speaker, conf }[]
  engine: string; model: string;
  summary: string;                          // 全体の要約（エージェントが書く）
}
interface Chapter {
  id: Id<'ch'>; title: string; start: Frame; end: Frame;
  points: string[];                         // この章の要点
  importance: 'core' | 'support' | 'aside';
}
```

### segments — カットの結果（本編の並び）

```ts
interface Segment {
  id: Id<'seg'>;
  range: { start: Frame; end: Frame };               // タイムライン上
  src: { from: SourceFrame; to: SourceFrame; take: Id<'take'> };  // 元素材の範囲
  text: string;                                       // この区間で話している内容（文字起こしから）
  chapter: Id<'ch'>;
  role: 'hook' | 'explain' | 'demo' | 'example' | 'summary' | 'cta' | 'aside';  // 構成上の役割
  video: VideoChoice;                                 // どのカメラ・画面を、どのレイアウトで
  zoom?: Keyframes<{ scale: number; focus: 'face' | 'cursor' | Point }>;
  transitionIn?: { kind: 'cut' | 'jump-zoom' | 'whoosh' | 'fade'; frames: number };
  decided: Decided;                                   // なぜ残したか
  removedNeighbors?: { kind: 'silence' | 'filler' | 'retake' | 'ng-marker' | 'off-topic'; src: { from: SourceFrame; to: SourceFrame }; decided: Decided }[];  // 前後で切ったもの（元に戻せるように）
  checks?: CheckResult[];
}

type VideoChoice =
  | { layout: 'camera-full'; camera: SourceId }
  | { layout: 'screen-full'; screen: SourceId }
  | { layout: 'screen-with-wipe'; screen: SourceId; camera: SourceId; wipe: { shape: 'circle' | 'rounded'; corner: 'bl' | 'br' | 'tl' | 'tr'; style: string } }
  | { layout: 'split-v'; top: SourceId; bottom: SourceId }
  | { layout: 'scene'; scene: Id<'scn'> };            // シーンのパターンを全画面で使う
```

**切ったものも記録する**（`removedNeighbors`）。「なぜ切ったか」が残るので、エージェントが「ここは切りすぎ」と判断して戻せる。

### scenes — シーンのパターン（型）

語り動画・技術動画には、繰り返し使う**シーンの型**がある。たとえば「黒地に波模様の背景、グラデーションの枠、中央にイラスト、左右に吹き出し、左下に丸ワイプ」という解説シーン。これを型として定義し、スロットに中身を入れるだけで使えるようにする。

```ts
interface Scene {
  id: Id<'scn'>;
  pattern: { id: string; version: string };          // 例: "explain-illust-bubbles@1"
  range: { start: Frame; end: Frame };
  slots: Record<string, SlotValue>;                   // パターンが宣言したスロットだけ（型で検証）
  animation?: { in: string; out: string };            // パターンが用意した出入りの動き
  decided: Decided;
}
type SlotValue =
  | { kind: 'text'; text: string; emphasis?: string[] }
  | { kind: 'image'; asset: SourceId }
  | { kind: 'video'; source: SourceId; from: SourceFrame }
  | { kind: 'code'; language: string; code: string; highlight?: number[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'number'; value: number; unit?: string };
```

パターンは `patterns/<id>/pattern.json`（スロットの型、レイアウト、アニメーション）と、描画の実体（HTML / CSS。HyperFrames などで透過付きの動画に描き出す）でできている。

```jsonc
// patterns/explain-illust-bubbles/pattern.json
{
  "id": "explain-illust-bubbles", "version": "1",
  "for": ["talk", "tech"], "aspect": ["16:9", "9:16"],
  "slots": {
    "illustration": { "kind": "image", "required": true, "hint": "人物の線画。黒背景で見えるもの" },
    "bubbleLeft":   { "kind": "text", "maxChars": 30 },
    "bubbleRight":  { "kind": "text", "maxChars": 30 },
    "wipe":         { "kind": "video", "default": "camera:front" }
  },
  "style": { "background": "waves-dark", "frame": "gradient-orange-red", "bubble": "white-rounded", "wipe": "circle-gradient" },
  "animation": { "in": ["bubbles-pop", "frame-draw"], "out": ["fade"] }
}
```

組み込みのパターン（技術動画・語り動画で定番のもの）:

| パターン | 内容 |
|---|---|
| `explain-illust-bubbles` | イラスト＋左右の吹き出し＋丸ワイプ（スクリーンショットの型） |
| `title-card` | 章の見出し |
| `bullet-points` | 箇条書きを1行ずつ出す |
| `compare-2col` | 2つを比べる（Before / After、A / B） |
| `ranking` | ランキング（3位から順に） |
| `big-number` | 大きな数字で強調（「3つのコツ」「90%削減」） |
| `quote` | 引用・発言の強調 |
| `code-focus` | コードを大きく見せ、行をハイライト（技術動画） |
| `terminal-typing` | ターミナルにコマンドを打つ様子（技術動画） |
| `screen-zoom-callout` | 画面の一部を拡大して枠で囲む（技術動画） |
| `cta-subscribe` | チャンネル登録・フォローの呼びかけ |

利用者は組み込みを継承して、自分の色・枠・フォントにした「自分の型」を作れる。テンプレートは、どのパターンをどんなときに使うかをプロンプトに書く（例: 「具体例を話すときは `explain-illust-bubbles`。吹き出しには発言の要点を15字以内で」）。

### captions — 字幕

```ts
interface Caption {
  id: Id<'cap'>;
  range: { start: Frame; end: Frame };
  text: string;                                      // 表示する文字（言い換え後）
  spoken: string;                                    // 実際に話した文字（文字起こしの原文）
  words: { text: string; start: Frame; end: Frame }[];  // 単語ハイライト用
  lines: string[];                                   // 改行後の各行（BudouX＋判定モデル）
  emphasis: { word: string; style: 'color' | 'scale' | 'box' }[];
  style: string;                                     // テンプレートの字幕スタイルの id
  position: { anchor: 'bottom' | 'top' | 'center'; y: number };  // 安全領域の中であることを検証
  corrections?: { from: string; to: string; decided: Decided }[]; // 誤変換の修正の記録
  decided: Decided;
}
```

`text` と `spoken` を分けて持つので、「言い換えすぎていないか」を検証できる。

### overlays、audio、masks、markers

```ts
type Overlay =
  | { kind: 'telop'; id: Id<'ov'>; range: Range; text: string; style: string; position: Point; decided: Decided }
  | { kind: 'image'; id: Id<'ov'>; range: Range; asset: SourceId; position: Rect; animation?: string; decided: Decided }
  | { kind: 'keystroke'; id: Id<'ov'>; range: Range; keys: string[] }            // 技術動画のキー表示
  | { kind: 'click-ring'; id: Id<'ov'>; at: Frame; position: Point }
  | { kind: 'logo'; id: Id<'ov'>; range: Range; asset: SourceId; corner: Corner };

interface AudioPlan {
  voice: { denoise: 'off' | 'light' | 'strong'; eq: string; loudness: number; truePeak: number };
  bgm: { id: Id<'bgm'>; asset: SourceId; range: Range; gainDb: number; duckDb: number; fadeIn: number; fadeOut: number; decided: Decided }[];
  sfx: { id: Id<'sfx'>; asset: SourceId; at: Frame; gainDb: number; trigger: 'emphasis' | 'section' | 'cut' | 'scene-in' | 'manual'; ruleRef?: string; decided: Decided }[];
}

interface Mask {
  id: Id<'mask'>; kind: 'pixelate' | 'blur' | 'fill'; source: SourceId;
  reason: 'pii:email' | 'pii:phone' | 'pii:token' | 'pii:address' | 'notification' | 'face' | 'plate' | 'manual';
  track: { frame: SourceFrame; box: Rect; confidence: number }[];
  decided: Decided;
}

type Marker =
  | { kind: 'chapter'; at: Frame; label: string }
  | { kind: 'ng' | 'important'; at: Frame; srcAt: SourceFrame; from: 'hotkey' }   // 撮影時の目印
  | { kind: 'note'; at: Frame; text: string; by: Decided['by'] };
```

### outputs と review — 出力と検査の状態

```ts
interface Output {
  target: 'youtube' | 'youtube-shorts' | 'tiktok' | 'instagram-reels';
  canvas: Canvas; preset: string;
  range?: Range;                                     // ショートの場合は切り出し範囲
  thumbnail?: { path: string; frame: Frame; generatedBy?: string };
  metadata: { title: string; titleCandidates: string[]; description: string; tags: string[]; chapters: boolean };
  render?: { path: string; hash: string; at: string; toolVersions: Record<string, string> };
  publish?: { status: 'draft' | 'scheduled' | 'published' | 'failed'; url?: string; at?: string };
}

interface ReviewState {
  lastCheck?: { run: Id<'chk'>; passed: number; failed: number; needsHuman: number; at: string };
  openItems: { ref: string; kind: 'decision' | 'check' | 'feedback'; summary: string }[];   // 未解決の一覧
  feedback: { id: Id<'fb'>; status: 'open' | 'done'; items: number }[];
}

interface CheckResult {
  check: 'black-frames' | 'freeze' | 'loudness' | 'spec' | 'audio-clicks' | 'cut-boundaries' | 'caption-safe-area'
       | 'caption-face-overlap' | 'pii-on-screen' | 'mosaic-tracking' | 'camera-switch';
  status: 'pass' | 'fail' | 'needs-human';
  score?: number; frames?: Frame[]; note?: string; run: Id<'chk'>;
}
```

## 大きさとの付き合い方

20分の動画では、字幕や単語の時刻で `timeline.json` が大きくなる。エージェントのコンテキストを無駄にしないよう、読み方を用意する。

| コマンド | 返すもの |
|---|---|
| `solocut tl summary` | 構成（章と要点）、区間の数、未解決の一覧、出力の状態。まず読むもの |
| `solocut tl show <id>` | 1つの要素とその周り（前後の区間、重なる字幕・シーン・効果音） |
| `solocut tl range 00:03:00-00:04:00` | その時間帯にあるすべての要素 |
| `solocut tl query 'segments[role=demo]'` | 条件で絞り込む |
| `solocut tl why <id>` | その要素の `decided` と、関係する履歴 |

単語単位の時刻のような大量のデータは `derived/` の別ファイルに置き、`timeline.json` からは参照する。`timeline.json` 本体は「人とエージェントが読む編集の設計図」として保つ。
