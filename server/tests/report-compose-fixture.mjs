export function dailySnapshot() {
  const window = { start_utc: '2026-10-06T16:00:00Z', end_utc: '2026-10-07T16:00:00Z', time_zone: 'Asia/Shanghai' };
  const cohort = { start_utc: '2026-10-05T16:00:00Z', end_utc: '2026-10-06T16:00:00Z', time_zone: 'Asia/Shanghai' };
  const evidence = { definition: 'Synthetic supplied definition', definition_confirmed: true, source: { label: 'Synthetic offline fixture', confirmed: true, complete_through_utc: window.end_utc }, window };
  return JSON.parse(JSON.stringify({
    title: 'Synthetic daily report', window, generated_at_utc: '2026-10-08T02:00:00Z', metrics: {
      new_user_next_day_retention: { ...evidence, window: cohort, followup_window: window, numerator: '20', denominator: '100' },
      active_next_day_retention: { ...evidence, window: cohort, followup_window: window, numerator: '55', denominator: '100' },
      chat_rate: { ...evidence, numerator: '100', denominator: '200' },
      mode_message_counts: { ...evidence, coverage_complete: true, modes: [{ mode: 'mode-a', count: '100' }, { mode: 'mode-b', count: '50' }] },
      openrouter_cost: { ...evidence, currency: 'USD', amount: '1.234567891', window_precision: 'exact' },
    },
  }));
}
