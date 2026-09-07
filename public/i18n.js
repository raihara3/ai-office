// Browser-side language: dictionaries for every user-facing UI string. The
// server-stored office setting is the source of truth (it rides on every
// snapshot); localStorage caches it so the first paint after a reload already
// uses the right words, mirroring the theme bootstrap in index.html.
//
// Static markup carries data-i18n attributes (plus data-i18n-placeholder /
// data-i18n-title / data-i18n-aria-label for attribute text) and is filled by
// translateMarkup(); dynamic strings call translate() at render time. The
// English text in index.html is only a pre-translation fallback.

export const LANGUAGE_STORAGE_KEY = 'ai-office-language';
const DEFAULT_LANGUAGE = 'en';

const dictionaries = {
  en: {
    'common.save': 'Save',
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'tabs.office': 'Office',
    'tabs.board': 'Board',
    'tabs.inbox': 'Inbox',
    'appbar.settings': 'Settings',
    'appbar.settingsTitle': 'Change office settings such as the office name',
    'appbar.team': 'Team',
    'appbar.teamTitle': 'Add a new team',
    'appbar.task': 'Task',
    'zoom.label': 'Zoom',
    'zoom.out': 'Zoom out',
    'zoom.fit': 'Fit to view',
    'zoom.in': 'Zoom in',
    'board.heading': 'Tasks',
    'board.open': 'Open board',
    'board.stripLabel': 'Tasks by team',
    'board.done': 'Done',
    'board.working': 'Working',
    'board.review': 'Needs review',
    'board.notStarted': 'Not started',
    'board.queued': 'Queued',
    'board.orphaned': 'No assignee',
    'board.summaryOpen': 'Open',
    'board.userColumn': 'You (boss)',
    'board.reorderHint': 'Drag to reorder columns',
    'board.fileTaskTo': 'File a task for {name}',
    'board.addTaskTo': 'Add a task for {name}',
    'board.addTask': 'Add task',
    'board.emptyDone': 'Finished tasks appear here',
    'board.emptyNoResident': 'Assign an AI resident to add tasks',
    'board.cardAriaLabel': 'Task details: {title}',
    'board.doneAtTitle': 'Completed at',
    'board.createdAtTitle': 'Created at',
    'board.refreshFailed': 'Could not refresh tasks. Showing the last loaded state.',
    'cardForm.title': 'File a task',
    'cardForm.subject': 'Subject',
    'cardForm.subjectPlaceholder': 'Task subject',
    'cardForm.body': "Details and steps (passed verbatim into the assignee's prompt)",
    'cardForm.assignee': 'Assignee',
    'cardForm.file': 'File task',
    'cardDetail.title': 'Task details',
    'cardDetail.editTitle': 'Edit task',
    'cardDetail.archive': 'Archive (remove from board)',
    'cardDetail.markDone': 'Mark done',
    'cardDetail.edit': 'Edit',
    'cardDetail.noBody': '(no body)',
    'cardDetail.loadingReports': 'Loading reports…',
    'cardDetail.notePlaceholder': "Add a note (included in the next run's prompt)",
    'cardDetail.appendNote': 'Add note',
    'cardDetail.save': 'Save',
    'cardDetail.noReports': 'No reports for this task yet',
    'cardDetail.reportsFailed': 'Failed to load reports',
    'cardDetail.reportLabel': 'Report',
    'inbox.title': 'Inbox',
    'inbox.searchPlaceholder': 'Search reports…',
    'inbox.searchLabel': 'Search report subjects, assignees, and bodies',
    'inbox.filtersLabel': 'Filter reports',
    'inbox.filterAll': 'All',
    'inbox.filterUnread': 'Unread',
    'inbox.filterFavorite': 'Favorites',
    'inbox.loading': 'Loading…',
    'inbox.unreadCount': '{count} unread',
    'inbox.allRead': 'All caught up',
    'inbox.sourceOffice': 'Office',
    'inbox.favorite': 'Favorite',
    'inbox.archive': 'Archive',
    'inbox.unfavoriteToArchive': 'Remove from favorites to archive',
    'inbox.emptyFiltered': 'No reports match',
    'inbox.emptyFilteredHint': 'Try changing the filter or search',
    'inbox.empty': 'No reports yet',
    'inbox.emptyHint': 'Reports from your AIs arrive here',
    'inbox.markReadFailed': 'Could not mark as read. Reopen the report and try again.',
    'inbox.copied': 'Copied the full report',
    'inbox.markedUnread': 'Marked as unread',
    'inbox.archivedNotice': 'Report archived',
    'inbox.copyFailed': 'Could not copy. Please try again.',
    'inbox.updateFailed': 'Could not update. Please try again.',
    'inbox.refreshFailed': 'Could not refresh reports. Showing the last loaded state.',
    'inbox.loadFailed': 'Failed to load',
    'inbox.retry': 'Retry',
    'reportDialog.close': 'Close report',
    'reportDialog.bodyLabel': 'Report body',
    'reportDialog.copyAll': 'Copy full text',
    'reportDialog.markUnread': 'Mark unread',
    'reportDialog.relatedTask': 'Related task',
    'reportDialog.nextUnread': 'Next unread',
    'settings.title': 'Office settings',
    'settings.officeName': 'Office name (up to 10 characters)',
    'settings.theme': 'Theme',
    'settings.themeLight': 'Light',
    'settings.themeDark': 'Dark',
    'settings.language': 'Language',
    'residentForm.displayName': 'Display name',
    'residentForm.mode': 'Permissions',
    'residentForm.modeReadOnly': 'Read-only',
    'residentForm.modeEdit': 'Edit',
    'residentForm.modeWarning':
      'Edit-mode runs proceed without approval prompts (headless runs cannot answer them). The agent changes files and runs commands without confirmation — and except for the Codex sandbox, it is not confined to the working directory. Enable this only for instructions and directories you trust.',
    'residentForm.model': 'Model (pick a suggestion or enter a full model ID)',
    'residentForm.modelPlaceholder': 'Leave empty for the CLI default model',
    'residentForm.workingDirectory': 'Working directory',
    'residentForm.role': 'Role',
    'residentForm.roleBoard': 'Kanban (runs assigned cards)',
    'residentForm.roleScheduled': 'Scheduled (runs its instructions)',
    'residentForm.trigger': 'Trigger',
    'residentForm.triggerSchedule': 'Weekdays and times',
    'residentForm.triggerInterval': 'Fixed interval',
    'residentForm.times': 'Times (comma-separated)',
    'residentForm.intervalMinutes': 'Interval (minutes)',
    'residentForm.activeStart': 'Active from',
    'residentForm.activeEnd': 'Active until',
    'residentForm.precheck':
      'Precheck command (empty output skips the run; leave blank to always run)',
    'residentForm.instructions': 'Instructions (INSTRUCTIONS.md)',
    'residentForm.instructionsPlaceholder': "Describe this resident's role and workflow",
    'residentForm.enabled': 'Active (off pauses this resident)',
    'residentForm.runNow': 'Run now',
    'residentForm.unassign': 'Unassign',
    'residentForm.seatLabel': 'Seat {number}',
    'residentForm.addTitle': 'Add resident ({seat})',
    'residentForm.editTitle': '{name} ({seat})',
    'residentForm.unassignConfirm': 'Unassign {name}? (Its settings and reports will be archived.)',
    'weekday.mon': 'Mon',
    'weekday.tue': 'Tue',
    'weekday.wed': 'Wed',
    'weekday.thu': 'Thu',
    'weekday.fri': 'Fri',
    'weekday.sat': 'Sat',
    'weekday.sun': 'Sun',
    'teamForm.name': 'Team name',
    'teamForm.namePlaceholder': 'Dev team',
    'teamForm.seatCount': 'Seats (1–12)',
    'teamForm.delete': 'Delete team',
    'teamForm.addTitle': 'Add team',
    'teamForm.editTitle': 'Team settings ({name})',
    'teamForm.deleteConfirm':
      'Delete team "{name}"? (A team that still has residents cannot be deleted.)',
    'activity.title': 'Activity',
    'activity.titleFor': "{name}'s activity",
    'activity.statusWorking': 'Working',
    'activity.statusBlocked': 'Awaiting approval',
    'activity.statusWaiting': 'Awaiting input',
    'activity.statusBreak': 'Away',
    'activity.kindInspect': 'Inspecting',
    'activity.kindThink': 'Thinking',
    'activity.kindWork': 'Working',
    'activity.emergencyStop': 'Emergency stop',
    'activity.noResident': 'No resident is assigned.',
    'activity.starting': 'Starting…',
    'activity.lastRun': 'Last run {time} ({outcome})',
    'activity.neverRun': 'Not run yet',
    'activity.nextRun': 'Next run {time}',
    'activity.noSession': 'No session is running.',
    'activity.stateLabel': 'Status',
    'activity.nextLabel': 'Next',
    'activity.taskLabel': 'Task',
    'activity.workLog': 'Work log',
    'activity.subagents': 'Subagents',
    'activity.stopConfirm':
      "Emergency-stop {name}'s session? (The resident is paused until you turn it back on.)",
    'activity.stopFailed': 'Emergency stop failed: {message}',
    'office.greetingEnter': 'Hello!',
    'office.greetingLeave': 'See you!',
    'markdown.checkboxDone': 'Done',
    'markdown.checkboxOpen': 'Not done',
  },
  ja: {
    'common.save': '保存',
    'common.close': '閉じる',
    'common.cancel': 'キャンセル',
    'tabs.office': 'オフィス',
    'tabs.board': 'ボード',
    'tabs.inbox': 'インボックス',
    'appbar.settings': '設定',
    'appbar.settingsTitle': 'オフィス名などの設定を変更します',
    'appbar.team': 'チーム',
    'appbar.teamTitle': '新しいチームを追加します',
    'appbar.task': 'タスク',
    'zoom.label': 'ズーム',
    'zoom.out': '縮小',
    'zoom.fit': '全体表示に戻す',
    'zoom.in': '拡大',
    'board.heading': 'タスク',
    'board.open': 'ボードを開く',
    'board.stripLabel': 'チーム別のタスク',
    'board.done': '完了',
    'board.working': '作業中',
    'board.review': '要確認',
    'board.notStarted': '未着手',
    'board.queued': '待機中',
    'board.orphaned': '担当不在',
    'board.summaryOpen': '未完了',
    'board.userColumn': 'あなた(社長)',
    'board.reorderHint': 'ドラッグして列を並び替え',
    'board.fileTaskTo': '{name}にタスクを起票',
    'board.addTaskTo': '{name}にタスクを追加',
    'board.addTask': 'タスクを追加',
    'board.emptyDone': '完了したタスクがここに並びます',
    'board.emptyNoResident': '担当AIを配置するとタスクを追加できます',
    'board.cardAriaLabel': 'タスク詳細: {title}',
    'board.doneAtTitle': '完了日時',
    'board.createdAtTitle': '作成日時',
    'board.refreshFailed': 'タスクを更新できませんでした。表示中の内容を保持しています。',
    'cardForm.title': 'タスクを起票',
    'cardForm.subject': '件名',
    'cardForm.subjectPlaceholder': 'タスクの件名',
    'cardForm.body': '内容・手順(担当のプロンプトにそのまま入ります)',
    'cardForm.assignee': '担当',
    'cardForm.file': '起票する',
    'cardDetail.title': 'タスク詳細',
    'cardDetail.editTitle': 'タスクを編集',
    'cardDetail.archive': 'アーカイブ(ボードから削除)',
    'cardDetail.markDone': '完了にする',
    'cardDetail.edit': '編集',
    'cardDetail.noBody': '(本文なし)',
    'cardDetail.loadingReports': '報告を読み込み中…',
    'cardDetail.notePlaceholder': '追記(次回実行のプロンプトに含まれます)',
    'cardDetail.appendNote': '追記する',
    'cardDetail.save': '保存する',
    'cardDetail.noReports': 'このタスクの報告はまだありません',
    'cardDetail.reportsFailed': '報告の読み込みに失敗しました',
    'cardDetail.reportLabel': '報告',
    'inbox.title': 'インボックス',
    'inbox.searchPlaceholder': '報告を検索…',
    'inbox.searchLabel': '報告の件名・担当者・本文を検索',
    'inbox.filtersLabel': '報告の絞り込み',
    'inbox.filterAll': 'すべて',
    'inbox.filterUnread': '未読',
    'inbox.filterFavorite': 'お気に入り',
    'inbox.loading': '読み込み中…',
    'inbox.unreadCount': '未読 {count}',
    'inbox.allRead': 'すべて確認済み',
    'inbox.sourceOffice': 'オフィス',
    'inbox.favorite': 'お気に入り',
    'inbox.archive': 'アーカイブ',
    'inbox.unfavoriteToArchive': 'お気に入りを解除するとアーカイブできます',
    'inbox.emptyFiltered': '条件に合う報告はありません',
    'inbox.emptyFilteredHint': '絞り込みや検索条件を変えてください',
    'inbox.empty': '報告はまだありません',
    'inbox.emptyHint': 'AIからの報告がここに届きます',
    'inbox.markReadFailed': '既読にできませんでした。報告を開き直してお試しください。',
    'inbox.copied': '報告の全文をコピーしました',
    'inbox.markedUnread': '未読に戻しました',
    'inbox.archivedNotice': '報告をアーカイブしました',
    'inbox.copyFailed': 'コピーできませんでした。もう一度お試しください。',
    'inbox.updateFailed': '更新できませんでした。もう一度お試しください。',
    'inbox.refreshFailed': '報告を更新できませんでした。表示中の内容を保持しています。',
    'inbox.loadFailed': '読み込みに失敗しました',
    'inbox.retry': '再試行',
    'reportDialog.close': '報告を閉じる',
    'reportDialog.bodyLabel': '報告本文',
    'reportDialog.copyAll': '全文をコピー',
    'reportDialog.markUnread': '未読に戻す',
    'reportDialog.relatedTask': '関連タスク',
    'reportDialog.nextUnread': '次の未読',
    'settings.title': 'オフィス設定',
    'settings.officeName': 'オフィス名(10文字以内)',
    'settings.theme': 'テーマ',
    'settings.themeLight': 'ライトモード',
    'settings.themeDark': 'ダークモード',
    'settings.language': '言語',
    'residentForm.displayName': '表示名',
    'residentForm.mode': '権限',
    'residentForm.modeReadOnly': '読み取りのみ',
    'residentForm.modeEdit': '編集あり',
    'residentForm.modeWarning':
      '編集ありの実行は承認プロンプトなしで進みます(ヘッドレス実行のため確認できません)。ファイル変更・コマンド実行が無確認で行われ、Codex のサンドボックスを除き作業ディレクトリの外にも及び得ます。信頼できる指示とディレクトリにのみ有効にしてください。',
    'residentForm.model': 'モデル(候補から選択、またはフルモデルIDを入力)',
    'residentForm.modelPlaceholder': '空欄でCLIの既定モデル',
    'residentForm.workingDirectory': '作業ディレクトリ',
    'residentForm.role': '役割',
    'residentForm.roleBoard': 'カンバン(担当カードを実行)',
    'residentForm.roleScheduled': '定期実行(指示書を実行)',
    'residentForm.trigger': 'トリガー',
    'residentForm.triggerSchedule': '曜日と時刻を指定',
    'residentForm.triggerInterval': '一定間隔',
    'residentForm.times': '時刻(カンマ区切り)',
    'residentForm.intervalMinutes': '間隔(分)',
    'residentForm.activeStart': '稼働開始',
    'residentForm.activeEnd': '稼働終了',
    'residentForm.precheck': '事前チェックコマンド(出力が空なら実行をスキップ。空欄なら毎回実行)',
    'residentForm.instructions': '指示書(INSTRUCTIONS.md)',
    'residentForm.instructionsPlaceholder': 'この常駐員の役割・手順を書いてください',
    'residentForm.enabled': '稼働する(オフで一時停止)',
    'residentForm.runNow': '今すぐ実行',
    'residentForm.unassign': '割り当て解除',
    'residentForm.seatLabel': '席 {number}',
    'residentForm.addTitle': '常駐員を追加({seat})',
    'residentForm.editTitle': '{name}({seat})',
    'residentForm.unassignConfirm': '{name} の割り当てを解除しますか?(設定と報告はアーカイブされます)',
    'weekday.mon': '月',
    'weekday.tue': '火',
    'weekday.wed': '水',
    'weekday.thu': '木',
    'weekday.fri': '金',
    'weekday.sat': '土',
    'weekday.sun': '日',
    'teamForm.name': 'チーム名',
    'teamForm.namePlaceholder': '開発チーム',
    'teamForm.seatCount': '席数(1〜12)',
    'teamForm.delete': 'チームを削除',
    'teamForm.addTitle': 'チームを追加',
    'teamForm.editTitle': 'チーム設定({name})',
    'teamForm.deleteConfirm': 'チーム「{name}」を削除しますか?(所属する常駐員がいる場合は削除できません)',
    'activity.title': '作業状況',
    'activity.titleFor': '{name} の作業状況',
    'activity.statusWorking': '作業中',
    'activity.statusBlocked': '確認待ち',
    'activity.statusWaiting': '入力待ち',
    'activity.statusBreak': '離席中',
    'activity.kindInspect': '確認中',
    'activity.kindThink': '考え中',
    'activity.kindWork': '作業中',
    'activity.emergencyStop': '緊急停止',
    'activity.noResident': '常駐員が割り当てられていません。',
    'activity.starting': '起動中…',
    'activity.lastRun': '前回実行 {time}({outcome})',
    'activity.neverRun': 'まだ実行されていません',
    'activity.nextRun': '次回予定 {time}',
    'activity.noSession': 'セッションは動いていません。',
    'activity.stateLabel': '状態',
    'activity.nextLabel': '次回',
    'activity.taskLabel': '指示',
    'activity.workLog': '作業ログ',
    'activity.subagents': 'サブエージェント',
    'activity.stopConfirm':
      '{name} のセッションを緊急停止しますか?(稼働はオフになり、再度オンにするまで動きません)',
    'activity.stopFailed': '緊急停止に失敗しました: {message}',
    'office.greetingEnter': 'お邪魔します',
    'office.greetingLeave': '失礼します',
    'markdown.checkboxDone': '完了',
    'markdown.checkboxOpen': '未完了',
  },
};

function storedLanguage() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return Object.hasOwn(dictionaries, stored ?? '') ? stored : DEFAULT_LANGUAGE;
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

let language = storedLanguage();

export function currentLanguage() {
  return language;
}

export function translate(key, parameters = {}) {
  const template = dictionaries[language][key] ?? dictionaries[DEFAULT_LANGUAGE][key];
  if (template === undefined) throw new Error(`unknown translation key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    parameters[name] !== undefined ? String(parameters[name]) : match
  );
}

// Fills every data-i18n annotated element. A label often wraps its input
// (<label>Text<input></label>), so only the leading text node is replaced,
// never the children.
export function translateMarkup(root = document) {
  document.documentElement.lang = language;
  for (const element of root.querySelectorAll('[data-i18n]')) {
    const text = translate(element.dataset.i18n);
    const firstChild = element.firstChild;
    if (firstChild !== null && firstChild.nodeType === Node.TEXT_NODE) {
      firstChild.nodeValue = text;
    } else if (element.childElementCount === 0) {
      element.textContent = text;
    } else {
      element.insertBefore(document.createTextNode(text), firstChild);
    }
  }
  const attributeDatasetKeys = {
    placeholder: 'i18nPlaceholder',
    title: 'i18nTitle',
    'aria-label': 'i18nAriaLabel',
  };
  for (const [attributeName, datasetKey] of Object.entries(attributeDatasetKeys)) {
    for (const element of root.querySelectorAll(`[data-i18n-${attributeName}]`)) {
      element.setAttribute(attributeName, translate(element.dataset[datasetKey]));
    }
  }
}

// Adopts the authoritative language from a snapshot. Returns true when it
// changed, so the caller can re-render dynamic panels.
export function applyLanguage(nextLanguage) {
  if (!Object.hasOwn(dictionaries, nextLanguage) || nextLanguage === language) return false;
  language = nextLanguage;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    // Private-mode storage failures only cost the pre-paint cache.
  }
  translateMarkup();
  return true;
}
