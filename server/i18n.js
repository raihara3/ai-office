// Server-generated user-facing text in the office language (a user setting,
// default English). Strings produced at runtime — reports, #general mentions,
// resident prompts, run errors — are data written in the language current at
// generation time; switching the language later does not rewrite them.
//
// The current language is module state so callers without database access
// (watchers, the runner) can translate too. residents.js syncs it from the
// settings store on creation, on every snapshot read and on save, which also
// keeps a second server instance sharing the same office.db fresh within one
// snapshot poll.

export const DEFAULT_LANGUAGE = 'en';
export const SUPPORTED_LANGUAGES = ['en', 'ja'];

const dictionaries = {
  en: {
    'runner.workingDirectoryMissing': 'Working directory does not exist: {directory}',
    'runner.spawnFailed': 'Failed to launch: {message}',
    'runner.runFailed': 'Run failed: {message}',
    'runner.timedOut': 'The run timed out',
    'runner.stopped': 'Stopped by emergency stop',
    'runner.noOutput': '(no output)',
    'runner.exitCode': 'Exit code {code}',
    'state.reviewMention': '@boss Please take a look',
    'prompt.preamble':
      'You are "{displayName}", a member of the AI Office resident team. Follow the rules and the role instructions below.',
    'prompt.rules': [
      'Common rules:',
      '- Your final message is used as the report to the human. Keep it concise and write it in English.',
      '- If a human needs to review, confirm or decide something, write exactly "LEVEL: review-needed" on the first line of your final message and continue the body from the second line. Never put it mid-message or at the end.',
    ].join('\n'),
    'prompt.roleInstructions': '## Role instructions',
    'prompt.currentTask': '## Current task (from the kanban board)',
    'prompt.pastReports': '## Past reports for this task (oldest first)',
    'prompt.precheckOutput': '## Precheck output',
    'report.stoppedPrefix': 'Stopped by emergency stop.',
    'report.abnormalEndPrefix': 'The run did not finish normally ({outcome}).',
    'report.scheduledRunTitle': 'Scheduled run',
    'report.reviewCardBody':
      'A scheduled run finished needing review. Check the linked report.',
    'mention.stopped':
      '@boss Work was interrupted by an emergency stop (report posted on the whiteboard)',
    'mention.reviewNeeded':
      '@boss Please take a look (report posted on the whiteboard)',
    'mention.taskDone':
      '@boss Task "{title}" is done (report posted on the whiteboard)',
    'mention.workDone': '@boss The work is done (report posted on the whiteboard)',
    'board.noteHeading': 'Note',
    'watcher.waitingForPlanApproval': 'Waiting for plan approval',
    'watcher.waitingForAnswer': 'Waiting for an answer',
  },
  ja: {
    'runner.workingDirectoryMissing': '作業ディレクトリが存在しません: {directory}',
    'runner.spawnFailed': '起動に失敗しました: {message}',
    'runner.runFailed': '実行に失敗しました: {message}',
    'runner.timedOut': '実行がタイムアウトしました',
    'runner.stopped': '緊急停止しました',
    'runner.noOutput': '(出力なし)',
    'runner.exitCode': '終了コード {code}',
    'state.reviewMention': '@社長 確認をお願いします',
    'prompt.preamble':
      'あなたは AI Office の常駐チームの一員「{displayName}」です。以下のルールと役割指示に従って作業してください。',
    'prompt.rules': [
      '共通ルール:',
      '- 最後のメッセージが人間向けの報告として利用されます。日本語で簡潔にまとめてください。',
      '- 人間による確認・レビュー・判断が必要な場合は、最終メッセージの1行目に「LEVEL: review-needed」とだけ書き、2行目以降に本文を続けてください。本文の途中や末尾には書かないでください。',
    ].join('\n'),
    'prompt.roleInstructions': '## 役割指示',
    'prompt.currentTask': '## 今回のタスク(カンバンボードより)',
    'prompt.pastReports': '## このタスクのこれまでの報告(古い順)',
    'prompt.precheckOutput': '## 事前チェックの出力',
    'report.stoppedPrefix': '緊急停止されました。',
    'report.abnormalEndPrefix': '実行が正常に終了しませんでした({outcome})。',
    'report.scheduledRunTitle': '定期実行',
    'report.reviewCardBody':
      '定期実行が要確認で終了しました。リンクされた報告を確認してください。',
    'mention.stopped':
      '@社長 緊急停止により作業を中断しました(ホワイトボードに報告を掲示しました)',
    'mention.reviewNeeded': '@社長 確認をお願いします(ホワイトボードに報告を掲示しました)',
    'mention.taskDone': '@社長 タスク「{title}」が完了しました(ホワイトボードに報告を掲示しました)',
    'mention.workDone': '@社長 作業が完了しました(ホワイトボードに報告を掲示しました)',
    'board.noteHeading': '追記',
    'watcher.waitingForPlanApproval': 'プラン確認待ち',
    'watcher.waitingForAnswer': '質問への回答待ち',
  },
};

let currentLanguage = DEFAULT_LANGUAGE;

export function setCurrentLanguage(language) {
  if (SUPPORTED_LANGUAGES.includes(language)) currentLanguage = language;
}

export function getCurrentLanguage() {
  return currentLanguage;
}

export function translate(key, parameters = {}) {
  const template = dictionaries[currentLanguage][key] ?? dictionaries[DEFAULT_LANGUAGE][key];
  if (template === undefined) throw new Error(`unknown translation key: ${key}`);
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    parameters[name] !== undefined ? String(parameters[name]) : match,
  );
}
