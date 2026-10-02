export type AnalyticsConfig = {
  app: string; events: readonly string[]; pages?: readonly string[]; origins: readonly string[];
  previewPrefix: string; enabled?: boolean; endpoint?: string;
};
export type Analytics = {
  track(eventName: string, pagePath?: string): Promise<boolean>;
  page(pagePath?: string): void;
  disable(): void;
  isHosted(): boolean;
  isEnabled(): boolean;
};
export function createAnalytics(config: AnalyticsConfig): Analytics;
export function mountPrivacyControl(container: Element | null, analytics: Analytics): void;
