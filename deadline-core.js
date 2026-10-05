(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TodoDeadline = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const dateKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const timestamp = (task) => task.deadline && Number.isFinite(Date.parse(task.deadline)) ? Date.parse(task.deadline) : Infinity;
  const dueToday = (task, now = new Date()) => Number.isFinite(timestamp(task)) && dateKey(new Date(timestamp(task))) === dateKey(now);
  function inputValue(task) {
    if (!Number.isFinite(timestamp(task))) return '';
    const date = new Date(timestamp(task));
    return `${dateKey(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
  function describe(task, now = new Date()) {
    if (!Number.isFinite(timestamp(task))) return '';
    const date = new Date(timestamp(task));
    const text = new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) }).format(date);
    return `마감 ${text}${task.done ? '' : timestamp(task) < now.getTime() ? ' · 기한 지남' : dueToday(task, now) ? ' · 오늘 마감' : ''}`;
  }
  function upcoming(tasks, today) {
    return tasks.filter((task) => !task.done && (task.date > today || Number.isFinite(timestamp(task)))).sort((a, b) => timestamp(a) - timestamp(b) || a.date.localeCompare(b.date) || a.createdAt - b.createdAt);
  }
  function remaining(tasks, now = new Date()) {
    return tasks.filter((task) => !task.done && (task.date === dateKey(now) || dueToday(task, now))).sort((a, b) => Number(dueToday(b, now)) - Number(dueToday(a, now)) || timestamp(a) - timestamp(b) || a.createdAt - b.createdAt);
  }
  return { timestamp, dueToday, inputValue, describe, upcoming, remaining };
});
