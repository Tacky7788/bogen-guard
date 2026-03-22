# Bogen Guard

ゲーム中の暴言をリアルタイム検知して、画面に画像をオーバーレイ表示するデスクトップアプリ。

## 特徴
- リアルタイム音声認識（VAD + Whisper）
- NGワード検知で好きな画像をオーバーレイ表示
- 10種類以上のSTTモデル対応
- GPU加速（Vulkan/CUDA）
- Web Speech API なら完全無料

## インストール
1. [Releases](../../releases) から `Bogen Guard_x.x.x_x64-setup.exe` をダウンロード
2. インストーラーを実行
3. 初回起動時にSTTモデルを選択・ダウンロード

## 使い方
1. オーバーレイ画像を追加（ドラッグ&ドロップ）
2. STTモデルを選択
3. パワーボタンで開始
4. 暴言を検知すると画像が表示されます

※ ゲームはボーダーレスウィンドウで起動してください

## STTモデル
| モデル | サイズ | 特徴 |
|---|---|---|
| Web Speech API | - | クラウド、無料、高速 |
| Whisper Tiny | 75MB | 超軽量 |
| Whisper Small | 466MB | バランス |
| Large V3 Turbo | 547MB | 高精度・高速 |
| Kotoba Q5_0 | 538MB | 日本語特化 |
| Kotoba Q8_0 | 818MB | 日本語高精度 |

## 処理バックエンド
- CPU (BLAS)
- GPU (Vulkan/AMD)
- GPU (CUDA/NVIDIA)

## 技術スタック
- Tauri v2 + React + TypeScript
- whisper.cpp (Vulkan GPU対応)
- cpal (Rustネイティブマイク録音)
- VAD (音声区間検出)

## ビルド
```bash
npm install
npm run tauri:build
```

## ライセンス
MIT
