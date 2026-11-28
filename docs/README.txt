================================================================================
 PanaCharter - User Guide
================================================================================

PanaCharter is a desktop editor for creating custom song beatmaps. This guide
covers how to use the app: connecting to a server, creating a project, and
placing notes. It does not cover building the app from source.
(This guide is for version 1.1.0.)

--------------------------------------------------------------------------------
1. Getting started
--------------------------------------------------------------------------------

When you launch PanaCharter you can either:

  - Connect to a server: enter the server address, then your numeric User ID
    and transfer password (set in the game's own settings) to log in. This
    lets you browse, download, and upload songs.
  - Or press "Skip - work locally" to go straight to your local project list
    without logging in. You can always connect later (the server icon, top
    right) - all editing works fully offline.

--------------------------------------------------------------------------------
2. Projects
--------------------------------------------------------------------------------

The Projects screen has three tabs:

  - Projects: your local projects, stored on this computer.
  - My uploads: songs you've uploaded to the connected server (requires
    login).
  - Browse server: other songs available on the connected server, which you
    can download as an editable local project.

From the Projects tab you can:

  - New project: start a blank project and fill in its song details.
  - Import package (.zip): load a project package exported from PanaCharter, or
    downloaded from a server.
  - Batch import Bandori...: pick a folder of Bandori game assets and import
    multiple songs (charts, audio, and jackets) at once.

Each project card lets you Open it in the editor, Export it as a package
(.zip) to share or back up, or Delete it.

--------------------------------------------------------------------------------
3. The editor screen
--------------------------------------------------------------------------------

Opening a project shows:

  - A toolbar across the top with difficulty tabs, editing tools, playback
    controls, and settings.
  - The main chart canvas, where notes are placed on a scrolling timeline
    across 9 lanes.
  - A note preview panel on the left, showing an in-game-style preview of
    how the chart will actually play.
  - A status bar at the bottom with note counts, density, chart length, and
    any issues found in the chart.

Difficulty tabs (top left) switch between the song's difficulty levels, each
with its own star rating and its own set of notes. "Import" loads a chart
from another format (another PanaCharter project, the official game's own chart
files, Bandori, or Bestdori) into the current difficulty.

--------------------------------------------------------------------------------
4. Placing and editing notes
--------------------------------------------------------------------------------

Pick a tool from the toolbar (or press its number key):

  1  Select   - click/drag to select notes, for moving or deleting them
  2  Tap      - click to place a tap note
  3  Hold     - click and drag to place a hold note of the length you drag
  4  Star     - click to place a star note
  5  Slide    - click across lanes to build a chain of linked points; press
                Esc to end the chain, or drag the last point to end it in a
                hold
  6  Flick    - click an already-selected hold, or a selected slide's last
                point, to toggle its ending into a flick

Other editing actions:

  - Drag a note to move it; drag a hold's tail to resize its length.
  - Click an already-selected tap/star note (without dragging) to flip it to
    the other kind (with flicks turned on, it cycles tap -> star -> flick).
  - Right-click a note to delete it.
  - Shift+click to add/remove a note from the selection; drag on empty space
    (Select tool) to box-select several at once.
  - Delete/Backspace removes the selection.
  - Ctrl+Z / Ctrl+Y undo and redo.
  - Ctrl+C / Ctrl+X / Ctrl+V copy / cut / paste at the playhead;
    Ctrl+Shift+V pastes mirrored left-right. Notes that would land after the
    end of the song are not pasted, and a hold running past the end is cut
    off at the last grid line inside the song.
  - Ctrl+A selects every note in the current difficulty.

Flick notes are off by default, since ordinary charts don't use them. Tick
the checkbox to the right of the Flick button to turn them on (the choice is
remembered across projects). While it is off, the Flick tool is disabled and
the other flick shortcuts do nothing.

"Snap to grid", in the toolbar, pulls any note (or hold/slide length) that's
only a hair off the beat grid exactly onto it - handy after importing a
chart from elsewhere, or if notes that should land together ever look very
slightly out of sync.

The checkbox to the right of "Snap to grid" changes what moving notes does:
when it is ticked, dragging notes lands the earliest selected note exactly on
the grid even if it started off it, and the rest of the selection keeps its
positions relative to that note. It is off by default and is also remembered
across projects.

--------------------------------------------------------------------------------
5. Playing along: lane keys
--------------------------------------------------------------------------------

You can also place notes live, by playing along to the song on your
keyboard:

  A S D F G H J K L   Each key places a tap note, at the playhead, in one
                       of the 9 lanes (left to right = lanes 9 down to 1).
                       This works even while the song is playing. Hold a
                       key down while the song plays to place a hold note
                       instead of a tap.

These keys, and two related timing options, can be changed from the
"Settings" button in the toolbar:

  - Lane keys: click a lane's box, then press any key to bind it to that
    lane (it moves to the next box automatically, so you can rebind a whole
    row in one pass). "Clear" unbinds all 9; "Reset" restores the default
    A-L layout.
  - Input offset: how much earlier than your keypress the note is placed,
    to compensate for the small delay between pressing a key and it
    registering. Increase this if notes placed live land noticeably late.
  - Hold threshold: how long you need to hold a key down, while the song is
    playing, for it to count as a hold instead of a tap.

--------------------------------------------------------------------------------
6. Tempo, timing, and navigation
--------------------------------------------------------------------------------

  - snap / bpm / offset (toolbar): the current snap division, the song's
    beats-per-minute, and the grid's start offset.
  - "Tempo...": add, edit, or remove BPM and time-signature changes partway
    through the song - the grid and measure numbering follow each change
    from its point onward.
  - "Jump..." (or Ctrl+G): jump straight to a measure number.
  - Mouse wheel scrolls the timeline; Ctrl+wheel zooms; middle-click drag
    pans. Clicking the waveform seeks. The up/down (or left/right) arrow
    keys step the playhead by one snap division.
  - The layout dropdown (next to the zoom buttons) switches between
    "Vertical ↓" (time runs from the top to the bottom), "Vertical ↑" (from
    the bottom to the top) and "Horizontal →" (a left-to-right timeline). The
    choice is saved with the project, and the mouse wheel scrolls the
    matching way.

--------------------------------------------------------------------------------
7. The note preview panel
--------------------------------------------------------------------------------

The panel on the left shows an in-game-style preview: notes fly out from a
spawn point toward 9 judgment circles, the same way they would in the real
game, with a live combo counter above it. Below that:

  - A close-up graph of note density for the current and next few measures.
  - A graph of note density across the whole song, doubling as a seek bar -
    click or drag it to jump to that point (a tooltip shows the time and
    measure number), and the main editor view scrolls to follow.

Notes are drawn as outlines by default, star notes carry a white star, flick
notes are triangles pointing back at the spawn point, a ripple spreads where
a note lands on its judgment circle, a pink ring marks the spawn point, and
the song's jacket shows dimmed behind the panel. Notes that are judged at the
same moment are marked with a short white bar.

Drag the panel's right edge to resize it. Its size, speed, and width are all
remembered for next time.

Full-screen preview
  The ⛶ button at the panel's top right (or F11) opens a full-screen preview
  laid out like the in-game screen, with the jacket dimmed behind it. A
  header across the top holds the playback controls (including a button that
  jumps back to the start), the time, the song-density seek bar, and an exit
  button. F11 or Esc leaves full screen. Lane keys and the playback shortcuts
  keep working there. When playback starts from the very beginning, the
  jacket, song title and artist fade in for a couple of seconds first, and
  the music starts once they have faded out.

Preview options (in "Settings")
  - Speed: the game speed (1-10), or the time a note takes to fly in,
    directly in seconds.
  - Size: the preview's display size.
  - Note style: draw notes as outlines (the default) or filled in.
  - Note colors: color notes by their own type (the default), or by the
    song's attribute - Smile uses the tap color, Pure the hold color, Cool
    the slide color. Flick notes stay purple.
  - Spawn size: how large notes (and hold tails) are at the moment they
    appear. 0% grows them from nothing.
  - Landing ripple size: the size of the ripple (0 turns it off).
  - Full-screen preview: use the whole screen, or stay inside the app window.
  - Song-info card: whether the card is shown at all, and whether the title
    and artist appear in Japanese or English.

--------------------------------------------------------------------------------
8. Sound and playback settings
--------------------------------------------------------------------------------

  - Space bar (or the play button) plays/pauses.
  - The rate dropdown changes playback speed (0.5x / 0.75x / 1x).
  - 🔔 toggles a tick sound on each note during playback, with a choice of
    tick sound.
  - 🔊 adjusts the playback volume. The number box beside the slider sets it
    exactly (0-100%).
  - In "Settings", "Note tick volume" sets how loud the tick is (0-200% of
    its default level), separately from the playback volume.

These settings, and the note preview's size/speed, are all remembered
across every project you open.

--------------------------------------------------------------------------------
9. Song settings and uploading
--------------------------------------------------------------------------------

"Song settings", in the toolbar, opens the song's details: title and artist
(in Japanese and English), a short title, a sort key, attribute, group, the
jacket image, the audio file, and the menu preview clip's start time and
length.

Everything you do autosaves automatically. When you're ready to publish,
press "Upload" to send the song (and all its difficulties) to the connected
server. If you've already uploaded that song before, uploading again offers
to update it in place - it keeps the same song ID and players' existing
scores, and only re-sends audio/jacket files that actually changed.

--------------------------------------------------------------------------------
Need the full list of shortcuts?
--------------------------------------------------------------------------------

Press the "?" button in the editor's toolbar at any time for the complete,
up-to-date list of keyboard and mouse shortcuts.

--------------------------------------------------------------------------------
Version and credits
--------------------------------------------------------------------------------

The "i" button at the top right of the window opens the About dialog: the
version you are running, links to the download page and the source
repository, and the credits.


================================================================================
 PanaCharter - 使い方ガイド
================================================================================

PanaCharterは、カスタム楽曲の譜面を作成するためのデスクトップ用エディタです。この
ガイドでは、サーバーへの接続、プロジェクトの作成、ノーツの配置方法など、アプ
リの操作方法を説明します。ソースからのビルド方法は扱いません。
(このガイドはバージョン1.1.0向けです。)

--------------------------------------------------------------------------------
1. はじめに
--------------------------------------------------------------------------------

PanaCharterを起動すると、次のいずれかを選べます。

  - サーバーに接続する: サーバーのアドレスを入力し、続けて(ゲーム内の設定で
    設定した)数字のユーザーIDと転送用パスワードでログインします。これによ
    り楽曲の閲覧・ダウンロード・アップロードができるようになります。
  - 「Skip - work locally」を押して、ログインせずにそのままローカルのプロジ
    ェクト一覧へ進む。ログインは後からいつでも行えます(右上のサーバーアイ
    コン)。編集作業自体はオフラインでも全て行えます。

--------------------------------------------------------------------------------
2. プロジェクト
--------------------------------------------------------------------------------

プロジェクト画面には3つのタブがあります。

  - Projects: この端末に保存されているローカルのプロジェクト。
  - My uploads: 接続中のサーバーにアップロード済みの楽曲(ログインが必要)。
  - Browse server: 接続中のサーバー上にある他の楽曲。編集可能なローカルプロ
    ジェクトとしてダウンロードできます。

Projectsタブからは、次の操作ができます。

  - New project: 新規プロジェクトを作成し、楽曲情報を入力する。
  - Import package (.zip): PanaCharterからエクスポートした、またはサーバーから
    ダウンロードしたプロジェクトパッケージを読み込む。
  - Batch import Bandori…: Bandoriのゲームアセットが入ったフォルダを選択し、
    複数の楽曲(譜面・音源・ジャケット)をまとめてインポートする。

各プロジェクトのカードからは、エディタで開く(Open)、パッケージ(.zip)とし
て共有・バックアップ用にエクスポートする(Export)、削除する(Delete)こと
ができます。

--------------------------------------------------------------------------------
3. エディタ画面について
--------------------------------------------------------------------------------

プロジェクトを開くと、次の構成になっています。

  - 画面上部のツールバー: 難易度タブ、編集ツール、再生操作、各種設定。
  - メインの譜面キャンバス: スクロールするタイムライン上、9レーンにノーツを
    配置します。
  - 左側のノーツプレビューパネル: 実際のゲームプレイに近い形で譜面のプレビ
    ューが表示されます。
  - 下部のステータスバー: ノーツ数、密度、譜面の長さ、譜面上の問題点などが
    表示されます。

難易度タブ(左上)では、楽曲の各難易度(それぞれ星レーティングとノーツを個
別に持つ)を切り替えられます。「Import」では、他のフォーマット(別のPanaCharter
プロジェクト、公式ゲーム本体の譜面ファイル、Bandori、Bestdori)の譜面を、現
在選択中の難易度へ読み込めます。

--------------------------------------------------------------------------------
4. ノーツの配置と編集
--------------------------------------------------------------------------------

ツールバーからツールを選びます(数字キーでも切り替え可能)。

  1  Select(選択) - クリック/ドラッグでノーツを選択し、移動や削除に使う
  2  Tap(タップ)  - クリックでタップノーツを配置
  3  Hold(ホールド)- クリックしたままドラッグし、ドラッグした長さのホール
                      ドノーツを配置
  4  Star(スター)  - クリックでスターノーツを配置
  5  Slide(スライド)- レーンをまたいでクリックしていくと連結ポイントの連
                      なり(スライドチェーン)を作成。Escでチェーンを終了、
                      または最後のポイントをドラッグするとホールドで終端
  6  Flick(フリック)- 選択済みのホールド、または選択済みスライドの最後の
                      ポイントをクリックすると、その終端をフリックに切り
                      替える

その他の編集操作:

  - ノーツをドラッグすると移動。ホールドの終端をドラッグすると長さを変更。
  - 選択済みのタップ/スターノーツを(ドラッグせず)クリックすると、もう一
    方の種類に切り替わる(フリックを有効にしている場合は、タップ→スター→
    フリックの順に切り替わる)。
  - ノーツを右クリックすると削除。
  - Shift+クリックで選択への追加/除外。選択ツールで何もない場所をドラッグ
    すると矩形選択で複数選択。
  - Delete/Backspaceで選択を削除。
  - Ctrl+Z / Ctrl+Yで元に戻す/やり直す。
  - Ctrl+C / Ctrl+X / Ctrl+Vで再生位置へコピー/切り取り/貼り付け。
    Ctrl+Shift+Vで左右反転して貼り付け。曲の終わりより後ろになるノーツは貼
    り付けられません。曲の終わりを越えるホールドは、曲内の最後のグリッド
    線で切り詰められます。
  - Ctrl+Aで現在の難易度の全ノーツを選択。

フリックノーツは、通常の譜面では使わないため、初期状態では無効です。ツールバ
ーのフリックボタンの右にあるチェックボックスをオンにすると使えるようになりま
す(この設定はプロジェクトをまたいで引き継がれます)。オフの間は、フリックツ
ールが使えず、そのほかのフリック用の操作も働きません。

ツールバーの「Snap to grid」は、拍のグリッドからごくわずかにずれているノー
ツ(ホールド/スライドの長さも含む)を正確にグリッド上へまとめて乗せます。
他所からインポートした譜面を整える際や、本来揃っているはずのノーツがわずか
にずれて見える場合に便利です。

「Snap to grid」の右にあるチェックボックスは、ノーツを移動したときの動作を切
り替えます。オンのときは、ノーツをドラッグすると、選択中の最も早いノーツが、
もともとグリッドから外れていても正確にグリッド上に乗り、残りのノーツはその
ノーツとの相対位置を保ちます。初期状態はオフで、この設定もプロジェクトをまた
いで引き継がれます。

--------------------------------------------------------------------------------
5. キーボードでのリアルタイム入力(レーンキー)
--------------------------------------------------------------------------------

キーボードを使い、曲に合わせてリアルタイムにノーツを配置することもできます。

  A S D F G H J K L   各キーを押すと、再生位置にそのレーン(左から順にレー
                       ン9〜1)のタップノーツが配置されます。曲の再生中でも
                       使用できます。再生中にキーを押し続けると、タップの
                       代わりにホールドノーツが配置されます。

これらのキー割り当てと、関連する2つのタイミング設定は、ツールバーの
「Settings」ボタンから変更できます。

  - Lane keys(レーンキー): レーンのボックスをクリックしてから好きなキーを
    押すと、そのレーンに割り当てられます(自動的に次のボックスへカーソル
    が移動するので、一列まとめて設定し直せます)。「Clear」で9レーン分す
    べての割り当てを解除、「Reset」で初期設定(A〜L)に戻せます。
  - Input offset(入力タイミング補正): キーを押してから実際にノーツが配置
    されるまでのわずかな遅延を補正するため、キー入力より何秒早い時間にノ
    ーツを配置するかを設定します。配置が遅れて感じる場合は値を大きくして
    ください。
  - Hold threshold(ホールド判定時間): 曲の再生中にキーをどれだけ長く押し
    続けたら、タップではなくホールドとして配置するかを設定します。

--------------------------------------------------------------------------------
6. テンポ・タイミング・移動
--------------------------------------------------------------------------------

  - snap / bpm / offset(ツールバー): 現在のスナップ分割数、楽曲のBPM、グリ
    ッドの開始オフセット。
  - 「Tempo…」: 曲の途中でのBPM・拍子の変更を追加/編集/削除できます。グリ
    ッドと小節番号は、変更された時点からそれに追従します。
  - 「Jump…」(またはCtrl+G): 指定した小節番号へ直接移動。
  - マウスホイールでタイムラインをスクロール、Ctrl+ホイールでズーム、中ボタ
    ンドラッグでパン。波形をクリックするとシーク。上下(または左右)矢印キ
    ーで、再生位置をスナップ分割1つ分ずつ移動。
  - ズームボタンの隣のレイアウトのドロップダウンで、「Vertical ↓」(時間が
    上から下へ進む)、「Vertical ↑」(下から上へ進む)、「Horizontal →」(左
    から右へ進む横タイムライン)を切り替え。選択はプロジェクトごとに保存さ
    れ、マウスホイールもそれに合わせた向きでスクロールします。

--------------------------------------------------------------------------------
7. ノーツプレビューパネル
--------------------------------------------------------------------------------

左側のパネルには、実際のゲームプレイに近い形でプレビューが表示されます。発
生点からノーツが飛び出し、9つの判定サークルへ向かっていく様子が、実際のゲー
ムと同じように再現され、その上にはリアルタイムのコンボ数が表示されます。そ
の下には、

  - 現在とその先数小節分のノーツ密度を表す拡大グラフ
  - 曲全体のノーツ密度を表すグラフ(シークバーを兼ねており、クリックやドラ
    ッグでその位置へ移動できます。ツールチップで時間と小節番号が表示され、
    メインのエディタ画面も連動してスクロールします)

があります。

ノーツは初期状態では枠線のみで描かれ、スターノーツには白い星が入り、フリッ
クノーツは射出点の方向に頂点を向けた三角形で表示されます。ノーツが判定サー
クルに重なると波紋が広がり、発生点はピンクの円で示され、パネルの背景には暗
くしたジャケットが表示されます。同じ瞬間に判定されるノーツには、短い白い線
が付きます。

パネルの右端をドラッグするとサイズを変更できます。表示サイズ・速度・幅は、い
ずれも次回起動時にも引き継がれます。

フルスクリーンプレビュー
  パネル右上の⛶ボタン(またはF11)で、ゲーム画面に近いレイアウトのフルスク
  リーンプレビューが開きます。背景には暗くしたジャケットが表示されます。上
  部のヘッダーには、再生操作(先頭に戻るボタンを含む)、時刻表示、曲の密度シ
  ークバー、終了ボタンが並びます。F11またはEscで終了します。レーンキーや再
  生のショートカットもそのまま使えます。曲の先頭から再生を始めるときは、まず
  ジャケット・曲名・アーティスト名が数秒間フェードイン・フェードアウトで表示
  され、その後に音楽が始まります。

プレビューの設定(「Settings」内)
  - Speed: ゲームスピード(1〜10)、または、ノーツが飛んでくるまでの時間を
    秒で直接指定。
  - Size: プレビューの表示サイズ。
  - Note style: ノーツを枠線で描く(初期設定)か、塗りつぶして描くか。
  - Note colors: ノーツの種類ごとの色(初期設定)で描くか、曲の属性の色で描
    くか。Smileはタップノーツ、Pureはホールドノーツ、Coolはスライドノーツ
    の色になります。フリックノーツは紫のままです。
  - Spawn size: ノーツ(とホールドの終端)が現れる瞬間の大きさ。0%だと、何
    もない状態から大きくなっていきます。
  - Landing ripple size: 波紋の大きさ(0でオフ)。
  - Full-screen preview: 画面全体を使うか、アプリのウィンドウ内にとどめるか。
  - 曲情報のカード: 表示するかどうか、曲名・アーティスト名を日本語と英語の
    どちらで表示するか。

--------------------------------------------------------------------------------
8. 音声・再生に関する設定
--------------------------------------------------------------------------------

  - スペースキー(または再生ボタン)で再生/一時停止。
  - 再生速度のドロップダウンで再生速度を変更(0.5倍/0.75倍/1倍)。
  - 🔔ボタンで、再生中の各ノーツに合わせたクリック音のオン/オフと音の種類
    を切り替え。
  - 🔊で再生音量を調整。スライダーの隣の数値入力欄では、0〜100%で正確に指定
    できます。
  - 「Settings」の「Note tick volume」で、クリック音の大きさ(既定値の0〜200
    %)を、再生音量とは別に設定。

これらの設定や、ノーツプレビューのサイズ・速度は、どのプロジェクトを開いて
も共通して引き継がれます。

--------------------------------------------------------------------------------
9. 楽曲設定とアップロード
--------------------------------------------------------------------------------

ツールバーの「Song settings」では、楽曲のタイトル・アーティスト名(日本語・
英語)、短縮タイトル、並び替え用のかな、属性、グループ、ジャケット画像、音
源ファイル、メニュー試聴の開始位置と長さといった詳細を設定できます。

作業内容はすべて自動保存されます。公開する準備ができたら「Upload」を押すと、
楽曲(すべての難易度を含む)が接続中のサーバーへ送信されます。その楽曲を以
前にもアップロードしたことがある場合は、上書き更新するかどうかを選べます
(同じ楽曲IDが維持され、プレイヤーの既存スコアも保持されます。また、実際に
変更のあった音源・ジャケットファイルのみが再送されます)。

--------------------------------------------------------------------------------
ショートカットの一覧を確認したい場合
--------------------------------------------------------------------------------

エディタのツールバーにある「？」ボタンを押すと、いつでも最新のキーボード/
マウスショートカット一覧を確認できます。

--------------------------------------------------------------------------------
バージョンとクレジット
--------------------------------------------------------------------------------

ウィンドウ右上の「i」ボタンで、Aboutダイアログが開きます。使用中のバージョ
ン、配布ページとソースコードのリポジトリへのリンク、クレジットを確認できま
す。
