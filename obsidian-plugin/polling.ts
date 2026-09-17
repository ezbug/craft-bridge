export function shouldPollEditor(hasToken: boolean, hasActiveMarkdownView: boolean): boolean {
  return hasToken && hasActiveMarkdownView;
}

export function pollingErrorNotice(previewId: string | undefined, message: string): string | undefined {
  return previewId ? `Craft Bridge：${message}` : undefined;
}
