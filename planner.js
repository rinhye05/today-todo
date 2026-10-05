(() => {
  const core = window.TodoPlannerCore;
  const schedule = window.TodoSchedule;
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let api;
  let cachedEvents = [];
  let editingPlan = null, editingEvent = null, editingCategory = null;
  let plannerObserver = null, plannerFrame = null;
  const state = () => api.getState();
  const stamp = () => ({ updatedAt: Date.now() });
  const categories = () => state().records.filter((item) => item.type === 'category' && !item.deleted);
  const category = (id) => categories().find((item) => item.id === id);
  const color = (id) => core.safeColor(category(id)?.color);
  const badge = (id) => category(id) ? `<span class="category-badge" style="--category-color:${color(id)}"><i></i>${esc(category(id).name)}</span>` : '';
  const weekdays = (id) => `<div class="weekday-picker" id="${id}">${core.days.map((day, index) => `<label><input type="checkbox" value="${index}"><span>${day}</span></label>`).join('')}</div>`;
  const close = (id) => `<button type="button" class="icon-button" data-planner-action="close" data-dialog="${id}" aria-label="닫기">×</button>`;
  const actions = (id, removeId) => `<div class="dialog-actions"><button type="button" id="${removeId}" class="delete-button hidden">삭제</button><span class="action-spacer"></span><button type="button" class="secondary-button" data-planner-action="close" data-dialog="${id}">취소</button><button class="primary-button">저장하기</button></div>`;

  function addDialogs() {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <dialog id="category-dialog" class="task-dialog planner-dialog"><div class="planner-dialog-content">
        <div class="dialog-head"><div><div class="eyebrow">CATEGORIES</div><h2>카테고리 관리</h2></div>${close('category-dialog')}</div>
        <p class="field-help">할 일, 주간 플랜, 일정을 같은 색으로 묶어요.</p><div id="category-list" class="category-list"></div>
        <form id="category-form"><div class="field-pair"><div><label class="field-label" for="category-name">이름</label><input class="text-field" id="category-name" maxlength="30" placeholder="예: 운동" required></div><div><label class="field-label" for="category-color">색깔</label><input type="color" id="category-color" value="#7bb8ff" class="text-field color-field"></div></div><p class="form-error" id="category-error" role="alert"></p><div class="dialog-actions"><button type="button" class="secondary-button" id="category-reset">새 카테고리</button><span class="action-spacer"></span><button class="primary-button" id="category-save">추가하기</button></div></form>
      </div></dialog>
      <dialog id="plan-dialog" class="task-dialog planner-dialog"><form id="plan-form">
        <div class="dialog-head"><div><div class="eyebrow">YOUR WEEKLY RHYTHM</div><h2 id="plan-dialog-title">주간 플랜 추가</h2></div>${close('plan-dialog')}</div>
        <label class="field-label" for="plan-title">어떤 시간을 보낼까요?</label><textarea class="text-field auto-grow-field" id="plan-title" maxlength="120" rows="1" placeholder="예: 운동하는 시간" required></textarea>
        <label class="field-label" for="plan-category">카테고리</label><div class="category-field"><select class="text-field" id="plan-category"></select><button type="button" class="secondary-button" data-planner-action="categories">관리</button></div>
        <div class="field-label">매주 반복할 요일</div>${weekdays('plan-weekdays')}
        <div class="field-pair" id="plan-common-time-field"><div><label class="field-label" for="plan-start-time">시작 시간</label><input class="text-field" type="time" id="plan-start-time" value="20:00" required></div><div><label class="field-label" for="plan-end-time">종료 시간</label><input class="text-field" type="time" id="plan-end-time" value="21:00" required></div></div><label class="notification-toggle"><span>요일별로 시간 다르게 설정</span><input id="plan-custom-times" type="checkbox" role="switch" /></label><div id="plan-day-times" class="day-time-fields hidden"></div>
        <p class="field-help">종료 시간 00:00은 그날의 자정을 뜻해요.</p>
        <label class="field-label" for="plan-start-date">적용 시작일</label><input class="text-field" type="date" id="plan-start-date" required>
        <label class="field-label" for="plan-note">메모</label><textarea class="text-field auto-grow-field" id="plan-note" maxlength="500" rows="2"></textarea>
        <p class="field-help" id="plan-edit-help">한 번 설정하면 매주 반복해요. 완료 기록은 날짜마다 따로 저장돼요.</p><p class="form-error" id="plan-error" role="alert"></p><label class="notification-toggle"><span>달력에서 플랜 기록 보기</span><input type="checkbox" id="view-plan-history" role="switch"></label><p class="field-help">켜 둔 플랜만 달력의 기록 선택 메뉴에 표시돼요. 꺼도 완료 기록은 유지돼요.</p>${actions('plan-dialog', 'delete-plan')}
      </form></dialog>
      <dialog id="event-dialog" class="task-dialog planner-dialog"><form id="event-form">
        <div class="dialog-head"><div><div class="eyebrow">CALENDAR EVENT</div><h2 id="event-dialog-title">일정 추가</h2></div>${close('event-dialog')}</div>
        <label class="field-label" for="event-title">일정 이름</label><input class="text-field" id="event-title" maxlength="120" placeholder="예: 친구와 저녁 약속" required>
        <label class="field-label" for="event-category">카테고리</label><div class="category-field"><select class="text-field" id="event-category"></select><button type="button" class="secondary-button" data-planner-action="categories">관리</button></div>
        <div class="field-pair"><div><label class="field-label" for="event-start-date">시작 날짜</label><input class="text-field" type="date" id="event-start-date" required></div><div><label class="field-label" for="event-end-date">종료 날짜</label><input class="text-field" type="date" id="event-end-date" required></div></div><p class="field-help" id="event-date-label"></p>
        <label class="chatgpt-context"><input type="checkbox" id="event-all-day"><span>종일 일정</span></label>
        <div class="field-pair"><div><label class="field-label" for="event-start-time">시작 시간</label><input class="text-field" type="time" id="event-start-time" value="19:00" required></div><div><label class="field-label" for="event-end-time">종료 시간</label><input class="text-field" type="time" id="event-end-time" value="20:00" required></div></div>
        <div class="field-pair"><div><label class="field-label" for="event-repeat">반복</label><select class="text-field" id="event-repeat"><option value="none">반복 안 함</option><option value="daily">일 단위</option><option value="weekly">주 단위</option><option value="monthly">월 단위</option></select></div><div id="event-interval-field"><label class="field-label" for="event-interval">반복 간격</label><input class="text-field" type="number" id="event-interval" value="1" min="1" max="365" required></div></div>
        <div id="event-weekday-field"><div class="field-label">반복 시작 요일</div>${weekdays('event-weekdays')}</div>
        <div id="event-until-field"><label class="field-label" for="event-until">반복 종료일 <span>선택</span></label><input class="text-field" type="date" id="event-until"><p class="field-help">비워두면 계속 반복해요. 종료일은 각 일정의 시작일 기준이에요. 월 단위는 시작 날짜를 반복하고 없는 날짜는 월말에 배치해요.</p></div>
        <label class="field-label" for="event-allow-plan">겹치는 주간 플랜을 수행할 수 있나요?</label><select class="text-field" id="event-allow-plan"><option value="no">수행하지 않음 · 해당 플랜을 달성 목표에서 제외</option><option value="yes">수행 가능 · 주간 플랜 유지</option></select>
        <div class="event-conflicts" id="event-conflicts"></div>
        <label class="field-label" for="event-note">메모</label><textarea class="text-field" id="event-note" maxlength="500" rows="2"></textarea><p class="field-help">여러 날에 걸친 일정은 시작 시각부터 종료 날짜의 종료 시각까지 이어져요. 수정·삭제는 반복 일정 전체에 적용돼요.</p><p class="form-error" id="event-error" role="alert"></p>${actions('event-dialog', 'delete-event')}
      </form></dialog>`;
    document.body.append(wrapper);
  }

  function fillCategories(select, value = select.value) {
    select.replaceChildren(new Option('카테고리 없음', ''), ...categories().map((item) => new Option(item.name, item.id)));
    select.value = category(value) ? value : '';
  }

  function prepare() {
    const from = core.weekStart(state().shownMonth);
    cachedEvents = core.eventInstances(state().records.filter((item) => item.type === 'event'), from, core.addDays(from, 41));
  }

  function calendarInfo(date, planId = null) {
    const model = core.dayModel(state().records, state().tasks, date, cachedEvents, state().routines);
    if (planId) model.plans = model.plans.filter((plan) => plan.id === planId);
    const eligible = model.plans.filter((item) => !item.blocked);
    const done = eligible.filter((item) => item.done).length;
    const status = !eligible.length ? 'off' : done === eligible.length ? 'done' : done ? 'partial' : date < state().today ? 'missed' : date === state().today ? 'pending' : 'planned';
    return { model, eligible, done, status, events: model.events.length, description: !eligible.length ? '주간 플랜 없음 또는 일정으로 제외' : `주간 플랜 ${done}/${eligible.length} 완료` };
  }

  function taskRow(task) {
    const deadline = window.TodoDeadline.describe(task);
    const routine = state().routines.find((item) => item.id === task.routineId);
    if (routine && Number.isFinite(core.minutes(task.routineTime))) {
      const sub = routine.subtask ? task.subtasks.find((item) => item.routineId === routine.id) : null;
      return routineRow({ routineId: routine.id, occurrenceDate: task.routineDate || task.date, title: sub?.title || task.title, categoryId: task.categoryId, time: task.routineTime, done: routine.subtask ? Boolean(sub?.done) : task.done });
    }
    return `<div class="weekly-task ${task.done ? 'done' : ''}"><input type="checkbox" data-action="toggle" data-id="${esc(task.id)}" ${task.done ? 'checked' : ''} aria-label="${esc(task.title)} 완료"><div><button data-action="edit" data-id="${esc(task.id)}" type="button">${esc(task.title)}</button>${deadline ? `<span class="weekly-deadline">${esc(deadline)}</span>` : ''}</div></div>`;
  }

  function routineRow(point) {
    return `<div class="routine-task-line ${point.done ? 'done' : ''}" style="--category-color:${color(point.categoryId)}"><div class="routine-point-row"><input class="plan-completion" type="checkbox" data-action="routinetoggle" data-routine="${esc(point.routineId)}" data-occurrence="${point.occurrenceDate}" ${point.done ? 'checked' : ''} ${point.occurrenceDate > state().today ? 'disabled' : ''} aria-label="${esc(point.title)} ${point.time} 완료"><button class="week-block-title" data-action="editroutine" data-routine="${esc(point.routineId)}">${esc(point.title)}</button><time>${point.time}</time></div></div>`;
  }

  function planCheck(plan, date, template = false) {
    const settings = state().records.find((item) => item.type === 'plan' && item.id === plan.id);
    if (settings?.showInCalendar !== true) return '';
    return `<input class="plan-completion" type="checkbox" data-planner-action="plan-check" data-id="${esc(plan.id)}" data-day="${date}" ${plan.done ? 'checked' : ''} ${template || plan.blocked || date > state().today ? 'disabled' : ''} aria-label="${esc(plan.title)} ${date} 플랜 완료">`;
  }

  function dayPlans(date) {
    const visible = new Set(state().records.filter((item) => item.type === 'plan' && item.showInCalendar === true).map((item) => item.id));
    return calendarInfo(date).model.plans.filter((plan) => visible.has(plan.id));
  }

  function dayPlanCard(plan, date) {
    return `<article class="task-card day-plan-card ${plan.done ? 'is-done' : ''}" data-day-plan="${esc(plan.id)}">${planCheck(plan, date)}<div class="task-body"><div class="task-title-line"><button type="button" class="task-title" data-planner-action="edit-plan" data-id="${esc(plan.id)}">${esc(plan.title)}</button></div>${plan.note ? `<div class="task-meta"><span>${esc(plan.note)}</span></div>` : ''}<div class="task-meta"><span class="routine-badge">▥ 주간 플랜</span><span>◷ ${esc(plan.startTime)}–${esc(plan.endTime)}</span>${badge(plan.categoryId)}${plan.blocked ? '<span>일정으로 제외</span>' : ''}</div></div></article>`;
  }

  function grid(model, template, footer = '') {
    const all = model.flatMap((day) => [...day.plans, ...(!template ? [...day.events.filter((item) => !item.allDay), ...day.routinePoints] : [])]);
    const begin = all.length ? Math.min(360, ...all.map((item) => Math.floor(item.start / 60) * 60)) : 360;
    const end = 1440;
    // Content is measured after rendering so widths and fonts determine the row heights.
    const sizes = Array((end - begin) / 15).fill(6);
    const offsets = [0]; sizes.forEach((size) => offsets.push(offsets.at(-1) + size));
    const position = (minute) => {
      const index = Math.min(sizes.length, Math.max(0, (minute - begin) / 15));
      return offsets[Math.floor(index)] + (index % 1) * (sizes[Math.floor(index)] || 0);
    };
    const height = offsets.at(-1);
    const hours = Array.from({ length: (end - begin) / 60 + 1 }, (_, i) => `<span data-minute="${begin + i * 60}" style="top:${position(begin + i * 60)}px">${core.time(begin + i * 60)}</span>`).join('');
    const lines = Array.from({ length: (end - begin) / 30 + 1 }, (_, i) => `<i class="time-line ${i % 2 ? 'half' : ''}" data-minute="${begin + i * 30}" style="top:${position(begin + i * 30)}px"></i>`).join('');
    const columns = model.map((day, index) => {
      const items = core.layout([...day.plans.map((plan) => ({ ...plan, kind: 'plan' })), ...(!template ? [...day.events.filter((event) => !event.allDay).map((event) => ({ ...event, kind: 'event' })), ...day.routinePoints.map((point) => ({ ...point, kind: 'routine' }))] : [])]);
      const blocks = items.filter((item) => item.end > begin && item.start < end).map((item) => {
        const top = position(Math.max(begin, item.start));
        const size = position(Math.min(end, item.end)) - top;
        const style = `--category-color:${color(item.categoryId)};top:${top}px;height:${Math.max(24, size - 3)}px;left:calc(${item.lane / item.lanes * 100}% + 2px);width:calc(${100 / item.lanes}% - 4px)`;
        const timing = `data-start-minute="${item.start}" data-end-minute="${item.end}"`;
        if (item.kind === 'routine') return `<article class="week-block routine-point" style="${style}" ${timing} data-routine-point="${esc(item.routineId)}"><div class="week-block-content">${routineRow(item)}</div></article>`;
        if (item.kind === 'event') return `<article class="week-block event-block" style="${style}" ${timing}><div class="week-block-content"><button class="week-block-title" data-planner-action="edit-event" data-id="${esc(item.id)}">▣ ${esc(item.title)}</button><small>${core.time(item.start)}–${core.time(item.end)}</small></div></article>`;
        return `<article class="week-block ${item.blocked ? 'blocked' : ''} ${item.done ? 'completed' : ''}" style="${style}" ${timing} data-plan="${esc(item.id)}" data-day="${day.date}"><div class="week-block-content"><div class="week-block-heading">${planCheck(item, day.date, template)}<button class="week-block-title" data-planner-action="edit-plan" data-id="${esc(item.id)}">${esc(item.title)}</button></div><small>${core.time(item.start)}–${core.time(item.end)}${item.blocked ? ' · 일정으로 제외' : ''}</small>${item.categoryId ? `<span class="block-category">${esc(category(item.categoryId)?.name || '')}</span>` : ''}${!template ? item.tasks.map(taskRow).join('') : ''}</div></article>`;
      }).join('');
      const allDay = !template ? day.events.filter((event) => event.allDay).map((event) => `<button class="all-day-event" style="--category-color:${color(event.categoryId)}" data-planner-action="edit-event" data-id="${esc(event.id)}">${esc(event.title)}</button>`).join('') : '';
      return `<div class="week-day"><div class="week-day-heading ${day.date === state().today && !template ? 'is-today' : ''}"><button data-planner-action="select-day" data-day="${day.date}"><b class="weekday-${index}">${core.days[index]}</b>${!template ? `<span>${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))}</span>` : ''}</button>${allDay}</div><div class="week-track" data-planner-action="new-plan-at" data-day="${day.date}" data-begin="${begin}" data-offsets="${offsets.join(',')}" style="height:${height}px">${lines}${blocks}</div></div>`;
    }).join('');
    const laneMinimum = Math.max(118, ...model.map((day) => {
      const lanes = core.layout([...day.plans, ...day.events.filter((item) => !item.allDay), ...day.routinePoints.map((item) => ({ ...item, isPoint: true }))]);
      return Math.max(0, ...lanes.filter((item) => item.isPoint).map((item) => item.lanes * 80));
    }));
    const headingHeight = Math.max(44, 30 + Math.max(0, ...model.map((day) => template ? 0 : day.events.filter((event) => event.allDay).length)) * 22);
    const timetable = `<div class="week-grid" style="--day-min-width:${laneMinimum}px;--grid-height:${height}px;--heading-height:${headingHeight}px"><div class="week-time-column"><div class="week-time-heading">TIME</div><div class="week-times" style="height:${height}px">${hours}</div></div>${columns}</div>`;
    return `<div id="planner-scroll" class="planner-scroll ${template ? '' : 'week-connected'}">${template ? timetable : `<div class="week-connected-content" style="--day-min-width:${laneMinimum}px">${timetable}${footer}</div>`}</div>`;
  }

  function fitPlannerGrid() {
    const root = $('#planner-scroll .week-grid');
    if (!root || !root.getBoundingClientRect().width) return;
    const tracks = [...root.querySelectorAll('.week-track')];
    const begin = Number(tracks[0].dataset.begin);
    const sizes = Array((1440 - begin) / 15).fill(6);
    const blocks = [...root.querySelectorAll('.week-block')].map((element) => {
      const style = getComputedStyle(element);
      const padding = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, key) => sum + parseFloat(style[key]), 0);
      return { element, start: Number(element.dataset.startMinute), end: Number(element.dataset.endMinute), needed: Math.ceil(element.querySelector('.week-block-content').getBoundingClientRect().height + padding) + 3 };
    }).sort((a, b) => (a.end - a.start) - (b.end - b.start));
    for (const block of blocks) {
      const first = Math.floor((block.start - begin) / 15), last = Math.ceil((block.end - begin) / 15);
      let available = 0, weight = 0;
      for (let i = first; i < last; i++) {
        const fraction = (Math.min(block.end, begin + (i + 1) * 15) - Math.max(block.start, begin + i * 15)) / 15;
        available += sizes[i] * fraction;
        weight += fraction;
      }
      // Grow the shared time axis, keeping adjacent blocks and all seven days aligned.
      if (block.needed > available) for (let i = first; i < last; i++) sizes[i] += (block.needed - available) / weight;
    }
    const offsets = [0]; sizes.forEach((size) => offsets.push(offsets.at(-1) + size));
    const position = (minute) => {
      const index = Math.min(sizes.length, Math.max(0, (minute - begin) / 15));
      return offsets[Math.floor(index)] + (index % 1) * (sizes[Math.floor(index)] || 0);
    };
    const height = offsets.at(-1);
    root.style.setProperty('--grid-height', `${height}px`);
    for (const track of [...tracks, root.querySelector('.week-times')]) track.style.height = `${height}px`;
    for (const track of tracks) track.dataset.offsets = offsets.join(',');
    for (const marker of root.querySelectorAll('[data-minute]')) marker.style.top = `${position(Number(marker.dataset.minute))}px`;
    for (const block of blocks) {
      block.element.style.top = `${position(block.start)}px`;
      block.element.style.height = `${position(block.end) - position(block.start) - 3}px`;
    }
    root.style.setProperty('--heading-height', 'auto');
    const headingHeight = Math.ceil(Math.max(...[...root.querySelectorAll('.week-day-heading')].map((element) => element.getBoundingClientRect().height)));
    root.style.setProperty('--heading-height', `${headingHeight}px`);
  }

  function schedulePlannerLayout() {
    if (plannerFrame !== null) return;
    plannerFrame = requestAnimationFrame(() => { plannerFrame = null; fitPlannerGrid(); });
  }

  function observePlannerLayout() {
    fitPlannerGrid();
    const root = $('#planner-scroll .week-grid');
    let width = root.getBoundingClientRect().width;
    plannerObserver = new ResizeObserver((entries) => {
      const resized = entries.some((entry) => entry.target !== root || Math.abs(entry.contentRect.width - width) > .5);
      width = root.getBoundingClientRect().width;
      if (resized) schedulePlannerLayout();
    });
    plannerObserver.observe(root);
    root.querySelectorAll('.week-block-content, .all-day-event').forEach((element) => plannerObserver.observe(element));
  }

  function renderPlanner() {
    const { view, selectedDate, today, records, tasks, routines } = state();
    plannerObserver?.disconnect();
    if (plannerFrame !== null) { cancelAnimationFrame(plannerFrame); plannerFrame = null; }
    if (!['overview', 'planner'].includes(view)) return;
    const template = view === 'planner';
    const model = core.weekModel(records, template ? [] : tasks, template ? core.addDays(core.weekStart(today), 7) : selectedDate, template ? [] : routines);
    const plans = model.flatMap((day) => day.plans);
    const eligible = plans.filter((plan) => !plan.blocked);
    const weekTasks = tasks.filter((task) => task.date >= model[0].date && task.date <= model[6].date);
    const range = `${model[0].date.replaceAll('-', '.')} — ${model[6].date.replaceAll('-', '.')}`;
    const toolbar = `<div class="planner-toolbar"><div><h2>${template ? '평상시의 일주일' : core.weekLabel(selectedDate)}</h2><p>${template ? '특별 일정이 없는 날의 기본 시간표예요. 빈 시간을 클릭해서 플랜을 추가할 수 있어요.' : range}</p></div><div class="planner-tools">${!template ? `<button class="icon-button" data-planner-action="prev-week" aria-label="이전 주">‹</button><button class="secondary-button" data-planner-action="this-week">이번 주</button><button class="icon-button" data-planner-action="next-week" aria-label="다음 주">›</button><input type="date" id="week-jump-date" value="${selectedDate}" aria-label="확인할 주의 날짜">` : ''}<button class="secondary-button" data-planner-action="new-plan">＋ 플랜 추가</button><button class="secondary-button" data-planner-action="categories">카테고리</button></div></div>`;
    const stats = !template ? `<div class="week-summary"><span><i class="summary-dot"></i>플랜 완료 <b>${eligible.filter((item) => item.done).length}/${eligible.length}</b></span><span>할 일 완료 <b>${weekTasks.filter((item) => item.done).length}/${weekTasks.length}</b></span><span>일정으로 제외 <b>${plans.filter((item) => item.blocked).length}</b></span><span class="week-summary-help">플랜 체크와 할 일 체크는 각각 기록해요.</span></div>` : `<p class="field-help">이 시간표는 다음 완전한 주를 기준으로 보여줘요. 실제 주간 기록과 특별 일정은 전체 보기에서 확인하세요.</p>`;
    const legend = `<div class="planner-category-legend">${categories().map((item) => badge(item.id)).join('')}<span>▣ 특별 일정</span></div>`;
    const bottom = template ? `<div class="plan-management-list">${records.filter((item) => item.type === 'plan' && !item.deletedFrom).map((plan) => `<article><div><strong>${esc(plan.title)}</strong><p>${plan.dayTimes ? plan.weekdays.map((day) => `${core.days[day]} ${esc(plan.dayTimes[day]?.startTime || plan.startTime)}–${esc(plan.dayTimes[day]?.endTime || plan.endTime)}`).join(' · ') : `${plan.weekdays.map((day) => core.days[day]).join('·')} · ${esc(plan.startTime)}–${esc(plan.endTime)}`} ${badge(plan.categoryId)}</p></div><div class="plan-record-actions"><label class="notification-toggle"><span>달력에서 플랜 기록 보기</span><input type="checkbox" role="switch" data-planner-action="toggle-plan-history" data-id="${esc(plan.id)}" ${plan.showInCalendar === true ? 'checked' : ''}></label><button class="secondary-button" data-planner-action="edit-plan" data-id="${esc(plan.id)}">수정</button></div></article>`).join('') || '<p class="planner-empty">플랜을 추가하면 매주 사용할 시간표가 만들어져요.</p>'}</div>` : `<div class="week-extra-heading"><h2>할일 목록</h2></div><div class="week-extras-scroll"><div class="week-extras">${model.map((day, index) => `<section class="week-extra-day" data-day="${day.date}"><div class="week-extra-title"><strong class="weekday-${index}">${core.days[index]}</strong><span>${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))}</span><button class="icon-button" data-planner-action="new-task-day" data-day="${day.date}" aria-label="${day.date} 할 일 추가">＋</button></div>${day.events.map((event) => `<button class="day-event" data-planner-action="edit-event" data-id="${esc(event.id)}" style="--category-color:${color(event.categoryId)}"><b>▣ ${esc(event.title)}</b><small>${event.allDay ? '종일' : `${core.time(event.start)}–${core.time(event.end)}`}</small></button>`).join('')}${day.plans.some((plan) => plan.tasks.length) ? `<p class="placed-count">시간표 안에 할 일 ${day.plans.reduce((count, plan) => count + plan.tasks.length, 0)}개</p>` : ''}${day.unplaced.map((task) => `<div class="unplaced-task">${badge(task.categoryId)}${taskRow(task)}</div>`).join('') || '<p class="planner-empty">추가 할 일이 없어요.</p>'}</section>`).join('')}</div></div>`;
    const oldScroll = $('#planner-scroll');
    const scroll = oldScroll ? { top: oldScroll.scrollTop, left: oldScroll.scrollLeft } : null;
    $('#planner-view').innerHTML = toolbar + stats + legend + grid(model, template, template ? '' : bottom) + (template ? bottom : '');
    observePlannerLayout();
    if (scroll) { $('#planner-scroll').scrollTop = scroll.top; $('#planner-scroll').scrollLeft = scroll.left; }
  }

  function repeatDescription(event) {
    if (!event.repeat || event.repeat === 'none') return '한 번';
    return `${event.interval || 1}${{ daily: '일', weekly: '주', monthly: '개월' }[event.repeat]}마다${event.repeat === 'weekly' ? ` · ${(event.weekdays || []).map((day) => core.days[day]).join('·')}` : ''}${event.repeatUntil ? ` · ${event.repeatUntil}까지` : ' · 계속 반복'}`;
  }

  function renderEvents() {
    if (state().view !== 'events') return;
    const events = state().records.filter((item) => item.type === 'event' && !item.deleted).sort((a, b) => a.startDate.localeCompare(b.startDate));
    $('#events-view').innerHTML = `<div class="planner-toolbar"><div><h2>나의 일정</h2><p>특별 일정과 반복 일정을 관리해요.</p></div><button class="secondary-button" data-planner-action="new-event">＋ 일정 추가</button></div>` + (events.map((event) => `<article class="event-card" style="--category-color:${color(event.categoryId)}"><div><h3>${esc(event.title)}</h3>${badge(event.categoryId)}<p>${esc(event.startDate)} (${core.days[schedule.parseDate(event.startDate).getDay()]}) ${event.endDate !== event.startDate ? `— ${esc(event.endDate)}` : ''} · ${event.allDay ? '종일' : `${esc(event.startTime)}–${esc(event.endTime)}`}</p><p>${esc(repeatDescription(event))}</p><small>${event.allowPlan ? '겹치는 플랜도 수행 가능' : '겹치는 플랜은 달성 목표에서 제외'}</small>${event.note ? `<p>${esc(event.note)}</p>` : ''}</div><button class="secondary-button" data-planner-action="edit-event" data-id="${esc(event.id)}">수정</button></article>`).join('') || '<p class="planner-empty">아직 일정이 없어요. 날짜와 시간을 정해서 추가해 보세요.</p>');
  }

  function renderCategories() {
    $('#category-list').innerHTML = categories().map((item) => `<div class="category-row">${badge(item.id)}<button type="button" class="text-link" data-planner-action="edit-category" data-id="${esc(item.id)}">수정</button><button type="button" class="text-link danger-text" data-planner-action="delete-category" data-id="${esc(item.id)}">삭제</button></div>`).join('') || '<p class="planner-empty">예: 운동, 공부, 업무, 휴식</p>';
    for (const id of ['task-category', 'routine-category', 'plan-category', 'event-category']) fillCategories($(`#${id}`));
  }

  function renderCalendarHistory(date, month, planId = null) {
    const stats = { done: 0, missed: 0, excluded: 0 };
    for (let day = 1; day <= new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(); day++) {
      const key = schedule.iso(new Date(month.getFullYear(), month.getMonth(), day));
      const info = calendarInfo(key, planId);
      stats.excluded += info.model.plans.filter((plan) => plan.blocked).length;
      stats.done += info.done;
      if (key < state().today) stats.missed += info.eligible.length - info.done;
    }
    $('#routine-month-stats').classList.remove('hidden'); $('#routine-day-detail').classList.remove('hidden');
    $('#routine-month-stats').innerHTML = `<div><b>${stats.done}</b><span>플랜 완료</span></div><div><b>${stats.missed}</b><span>지난 미완료</span></div><div><b>${stats.done + stats.missed ? Math.round(stats.done / (stats.done + stats.missed) * 100) : 0}%</b><span>수행률</span></div><p>오늘 대기·예정 제외 · 일정으로 제외 ${stats.excluded}개</p>`;
    const model = calendarInfo(date, planId).model;
    const title = state().records.find((item) => item.id === planId)?.title || '주간 플랜 전체';
    $('#routine-day-detail').innerHTML = `<span class="routine-detail-date">${date} · ${esc(title)}</span>${model.plans.map((plan) => `<label class="calendar-plan-check">${planCheck(plan, date)}<span>${esc(plan.title)}<small>${plan.blocked ? '일정으로 제외' : `${plan.startTime}–${plan.endTime}`}</small></span></label>`).join('') || '<p>이 날은 해당 플랜이 없어요.</p>'}`;
  }

  function render() {
    const { view, selectedDate } = state();
    $('#planner-view').classList.toggle('hidden', !['overview', 'planner'].includes(view));
    $('#events-view').classList.toggle('hidden', view !== 'events');
    $('.main-area').classList.toggle('overview-mode', ['overview', 'planner'].includes(view));
    $('#calendar-week-label').classList.toggle('hidden', view !== 'overview');
    $('#calendar-week-label').textContent = `${core.weekLabel(selectedDate)} · ${core.weekDates(selectedDate)[0].slice(5).replace('-', '/')}–${core.weekDates(selectedDate)[6].slice(5).replace('-', '/')}`;
    if (view === 'overview') $('#page-subtitle').textContent = '평소의 시간표 위에 이번 주의 할 일과 특별 일정을 모았어요.';
    if (view === 'planner') $('#page-subtitle').textContent = '꾸준히 이어갈 일주일의 기본 리듬을 만들어 보세요.';
    if (view === 'events') $('#page-subtitle').textContent = '날짜와 시간을 정하고 주간 플랜과 함께 확인해요.';
    renderCategories(); renderPlanner(); renderEvents(); renderDayEvents();
    if ($('#event-dialog').open) updateEventFields();
  }

  function renderDayEvents() {
    let target = $('#selected-day-events');
    if (!target) { target = document.createElement('div'); target.id = 'selected-day-events'; $('#agenda-list').after(target); }
    target.innerHTML = core.eventsOnDate(cachedEvents, state().selectedDate).map((event) => `<button class="day-event" style="--category-color:${color(event.categoryId)}" data-planner-action="edit-event" data-id="${esc(event.id)}"><b>▣ ${esc(event.title)}</b><small>${event.allDay ? '종일' : `${core.time(event.start)}–${core.time(event.end)}`}</small></button>`).join('');
  }

  const pickedDays = (id) => [...document.querySelectorAll(`#${id} input:checked`)].map((input) => Number(input.value));
  const setDays = (id, values) => document.querySelectorAll(`#${id} input`).forEach((input) => { input.checked = values.includes(Number(input.value)); });
  const snapshot = (plan) => Object.fromEntries(['title', 'categoryId', 'weekdays', 'startTime', 'endTime', 'dayTimes', 'startDate', 'endDate', 'note'].map((key) => [key, plan[key]]));
  function show(id) { if (!$(`#${id}`).open) $(`#${id}`).showModal(); }
  function resizePlanFields() {
    if (!$('#plan-dialog').open) return;
    for (const field of document.querySelectorAll('#plan-form .auto-grow-field')) {
      field.style.height = 'auto';
      const style = getComputedStyle(field);
      field.style.height = `${field.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
    }
    // A growing note can introduce a dialog scrollbar and narrow the title.
    // Measure again at the final width without collapsing the fields first.
    for (const field of document.querySelectorAll('#plan-form .auto-grow-field')) {
      const style = getComputedStyle(field);
      field.style.height = `${field.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`;
    }
  }
  function resetCategory() { editingCategory = null; $('#category-form').reset(); $('#category-error').textContent = ''; $('#category-save').textContent = '추가하기'; }
  function updatePlanTimes() {
    const custom = $('#plan-custom-times').checked;
    $('#plan-common-time-field').classList.toggle('hidden', custom);
    $('#plan-start-time').disabled = custom; $('#plan-end-time').disabled = custom;
    $('#plan-day-times').classList.toggle('hidden', !custom);
    const days = pickedDays('plan-weekdays');
    document.querySelectorAll('.plan-day-time-row').forEach((row) => {
      const active = custom && days.includes(Number(row.dataset.day));
      row.classList.toggle('hidden', !active);
      row.querySelectorAll('input').forEach((input) => { input.disabled = !active; });
    });
  }
  function openPlan(id = null, date = state().selectedDate, start = 1200) {
    editingPlan = state().records.find((item) => item.type === 'plan' && item.id === id) || null;
    const plan = editingPlan;
    $('#plan-form').reset(); $('#plan-error').textContent = '';
    $('#plan-dialog-title').textContent = plan ? '주간 플랜 수정' : '주간 플랜 추가';
    $('#plan-title').value = plan?.title || '';
    fillCategories($('#plan-category'), plan?.categoryId || '');
    setDays('plan-weekdays', plan?.weekdays || [schedule.parseDate(date).getDay()]);
    $('#plan-start-time').value = plan?.startTime || core.time(start);
    $('#plan-end-time').value = (plan?.endTime || core.time(Math.min(1440, start + 60))).replace('24:00', '00:00');
    $('#plan-custom-times').checked = Boolean(plan?.dayTimes);
    $('#plan-day-times').innerHTML = [0, 1, 2, 3, 4, 5, 6].map((day) => `<div class="day-time-row plan-day-time-row" data-day="${day}"><span>${core.days[day]}요일</span><input type="time" class="text-field" id="plan-time-day-${day}-start" value="${esc(plan?.dayTimes?.[day]?.startTime || $('#plan-start-time').value)}" aria-label="${core.days[day]}요일 플랜 시작" required><span>–</span><input type="time" class="text-field" id="plan-time-day-${day}-end" value="${esc((plan?.dayTimes?.[day]?.endTime || $('#plan-end-time').value).replace('24:00', '00:00'))}" aria-label="${core.days[day]}요일 플랜 종료" required></div>`).join('');
    updatePlanTimes();
    $('#plan-start-date').value = plan ? (plan.startDate < state().today ? state().today : plan.startDate) : state().today;
    $('#plan-start-date').min = plan ? state().today : '';
    $('#plan-note').value = plan?.note || '';
    $('#plan-edit-help').textContent = plan ? '변경은 적용 시작일 이후에 반영돼요. 이전 시간표와 완료 기록은 유지돼요.' : '한 번 설정하면 매주 반복해요. 완료 기록은 날짜마다 따로 저장돼요.';
    $('#delete-plan').classList.toggle('hidden', !plan);
    $('#view-plan-history').checked = plan?.showInCalendar === true;
    show('plan-dialog');
    resizePlanFields();
  }
  function savePlan(event) {
    event.preventDefault();
    const date = $('#plan-start-date').value, days = pickedDays('plan-weekdays'), title = $('#plan-title').value.trim();
    const readTime = (startValue, endValue) => ({ startTime: startValue, endTime: endValue === '00:00' ? '24:00' : endValue });
    const custom = $('#plan-custom-times').checked;
    const dayTimes = custom ? Object.fromEntries(days.map((day) => [day, readTime($(`#plan-time-day-${day}-start`).value, $(`#plan-time-day-${day}-end`).value)])) : null;
    const shared = custom ? dayTimes[days[0]] : readTime($('#plan-start-time').value, $('#plan-end-time').value);
    const validTimes = shared && Object.values(dayTimes || { shared }).every((value) => Number.isFinite(core.minutes(value.startTime)) && core.minutes(value.endTime) > core.minutes(value.startTime));
    if (!title || !days.length || !schedule.validDate(date) || !validTimes || (editingPlan && date < state().today)) { $('#plan-error').textContent = '이름, 요일, 적용일을 확인하고 각 요일의 종료 시간을 시작 이후로 설정해 주세요.'; return; }
    const values = { title, showInCalendar: $('#view-plan-history').checked, categoryId: $('#plan-category').value, weekdays: days, ...shared, dayTimes, startDate: date, note: $('#plan-note').value.trim(), ...stamp() };
    const id = editingPlan?.id;
    api.mutate(({ records }) => {
      const plan = records.find((item) => item.id === id);
      if (plan) {
        const versions = (plan.versions || []).filter((item) => item.startDate < date).map((item) => ({ ...item, until: item.until < date ? item.until : core.addDays(date, -1) }));
        if (plan.startDate < date) versions.push({ ...snapshot(plan), until: core.addDays(date, -1) });
        Object.assign(plan, values, { versions, deletedFrom: null });
      } else records.push({ id: uid(), type: 'plan', createdAt: Date.now(), versions: [], ...values });
    });
    $('#plan-dialog').close(); api.toast('주간 플랜을 저장했어요.');
  }
  function togglePlan(id, date) {
    const plan = core.dayModel(state().records, state().tasks, date).plans.find((item) => item.id === id);
    if (!plan || plan.blocked || date > state().today) return;
    api.mutate(({ records }) => {
      const check = records.find((item) => item.type === 'plan-check' && item.planId === id && item.date === date);
      const values = { done: !plan.done, snapshot: snapshot(plan), ...stamp() };
      if (check) Object.assign(check, values);
      else records.push({ id: `plan-check-${id}-${date}`, type: 'plan-check', planId: id, date, createdAt: Date.now(), ...values });
    });
  }
  function eventValues() {
    const startDate = $('#event-start-date').value, endDate = $('#event-end-date').value;
    const repeat = $('#event-repeat').value;
    return { title: $('#event-title').value.trim(), categoryId: $('#event-category').value, startDate, endDate, allDay: $('#event-all-day').checked, startTime: $('#event-start-time').value, endTime: startDate === endDate && $('#event-end-time').value === '00:00' ? '24:00' : $('#event-end-time').value, repeat, interval: repeat === 'none' ? 1 : Number($('#event-interval').value), weekdays: pickedDays('event-weekdays'), repeatUntil: repeat === 'none' ? '' : $('#event-until').value, allowPlan: $('#event-allow-plan').value === 'yes', note: $('#event-note').value.trim() };
  }
  function updateEventFields() {
    const value = eventValues();
    $('#event-interval-field').classList.toggle('hidden', value.repeat === 'none');
    $('#event-interval').disabled = value.repeat === 'none';
    $('#event-weekday-field').classList.toggle('hidden', value.repeat !== 'weekly');
    $('#event-until-field').classList.toggle('hidden', value.repeat === 'none');
    $('#event-until').disabled = value.repeat === 'none';
    $('#event-start-time').disabled = value.allDay; $('#event-end-time').disabled = value.allDay;
    $('#event-end-date').min = value.startDate; $('#event-until').min = value.startDate;
    $('#event-date-label').textContent = schedule.validDate(value.startDate) && schedule.validDate(value.endDate) ? `${core.days[schedule.parseDate(value.startDate).getDay()]}요일 시작 · ${core.days[schedule.parseDate(value.endDate).getDay()]}요일 종료` : '';
    let matches = [];
    if (schedule.validDate(value.startDate) && schedule.validDate(value.endDate) && value.endDate >= value.startDate) {
      const through = core.addDays(value.startDate, 6);
      const instances = core.eventInstances([{ ...value, id: 'preview' }], value.startDate, through);
      for (let date = value.startDate; date <= through; date = core.addDays(date, 1)) {
        const events = core.eventsOnDate(instances, date);
        matches.push(...core.planInstances(state().records, date).filter((plan) => events.some((item) => core.overlaps(plan, item))).map((plan) => `${date.slice(5)} ${plan.title}`));
      }
    }
    $('#event-conflicts').textContent = matches.length ? `시작일부터 7일 내 겹치는 플랜: ${matches.join(', ')}. ${value.allowPlan ? '플랜을 유지해요.' : '미완료 플랜은 달성 목표에서 제외해요.'}` : '시작일부터 7일 내 겹치는 주간 플랜이 없어요.';
  }
  function openEvent(id = null) {
    editingEvent = state().records.find((item) => item.type === 'event' && item.id === id) || null;
    const item = editingEvent;
    $('#event-form').reset(); $('#event-error').textContent = '';
    $('#event-dialog-title').textContent = item ? '일정 수정' : '일정 추가';
    $('#event-title').value = item?.title || '';
    fillCategories($('#event-category'), item?.categoryId || '');
    $('#event-start-date').value = item?.startDate || state().selectedDate;
    $('#event-end-date').value = item?.endDate || state().selectedDate;
    $('#event-all-day').checked = Boolean(item?.allDay);
    $('#event-start-time').value = item?.startTime || '19:00';
    $('#event-end-time').value = (item?.endTime || '20:00').replace('24:00', '00:00');
    $('#event-repeat').value = item?.repeat || 'none'; $('#event-interval').value = item?.interval || 1;
    setDays('event-weekdays', item?.weekdays || [schedule.parseDate($('#event-start-date').value).getDay()]);
    $('#event-until').value = item?.repeatUntil || '';
    $('#event-allow-plan').value = item?.allowPlan ? 'yes' : 'no';
    $('#event-note').value = item?.note || '';
    $('#delete-event').classList.toggle('hidden', !item);
    updateEventFields(); show('event-dialog');
  }
  function saveEvent(event) {
    event.preventDefault(); const values = eventValues();
    const validTimes = values.allDay || (Number.isFinite(core.minutes(values.startTime)) && Number.isFinite(core.minutes(values.endTime)) && (values.endDate > values.startDate || core.minutes(values.endTime) > core.minutes(values.startTime)));
    if (!values.title || !schedule.validDate(values.startDate) || !schedule.validDate(values.endDate) || values.endDate < values.startDate || !validTimes || !Number.isInteger(values.interval) || values.interval < 1 || values.interval > 365 || (values.repeat === 'weekly' && !values.weekdays.length) || (values.repeatUntil && (!schedule.validDate(values.repeatUntil) || values.repeatUntil < values.startDate))) { $('#event-error').textContent = '날짜·시간과 반복 설정을 확인해 주세요. 종료 시점은 시작 이후여야 해요.'; return; }
    const id = editingEvent?.id;
    api.mutate(({ records }) => {
      const item = records.find((record) => record.id === id);
      if (item) Object.assign(item, values, stamp());
      else records.push({ id: uid(), type: 'event', createdAt: Date.now(), ...values, ...stamp() });
    });
    $('#event-dialog').close(); api.toast('일정을 저장했어요.');
  }
  function bindForms() {
    $('#plan-form').addEventListener('submit', savePlan);
    $('#plan-form').addEventListener('input', resizePlanFields);
    $('#plan-form').addEventListener('change', (event) => {
      if (['plan-start-time', 'plan-end-time'].includes(event.target.id)) {
        const suffix = event.target.id === 'plan-start-time' ? 'start' : 'end';
        document.querySelectorAll(`#plan-day-times input[id$="-${suffix}"]`).forEach((input) => { input.value = event.target.value; });
      }
      if (event.target.id === 'plan-custom-times' || event.target.closest('#plan-weekdays')) updatePlanTimes();
    });
    window.addEventListener('resize', () => { resizePlanFields(); schedulePlannerLayout(); });
    document.fonts.ready.then(() => { resizePlanFields(); schedulePlannerLayout(); });
    document.fonts.addEventListener('loadingdone', () => { resizePlanFields(); schedulePlannerLayout(); });
    $('#event-form').addEventListener('submit', saveEvent);
    $('#event-form').addEventListener('input', (event) => {
      if (event.target.id === 'event-start-date') {
        if ($('#event-end-date').value < event.target.value) $('#event-end-date').value = event.target.value;
        if (!editingEvent && schedule.validDate(event.target.value)) setDays('event-weekdays', [schedule.parseDate(event.target.value).getDay()]);
      }
      updateEventFields();
    });
    $('#category-reset').addEventListener('click', resetCategory);
    $('#category-form').addEventListener('submit', (event) => {
      event.preventDefault(); const name = $('#category-name').value.trim();
      if (!name || categories().some((item) => item.id !== editingCategory && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) { $('#category-error').textContent = '비어 있지 않은, 서로 다른 이름을 입력해 주세요.'; return; }
      const id = editingCategory || uid(), value = { name, color: core.safeColor($('#category-color').value), ...stamp() };
      api.mutate(({ records }) => {
        const item = records.find((record) => record.id === id);
        if (item) Object.assign(item, value); else records.push({ id, type: 'category', createdAt: Date.now(), ...value });
      });
      for (const parent of ['task', 'routine', 'plan', 'event']) if ($(`#${parent}-dialog`).open) fillCategories($(`#${parent}-category`), id);
      resetCategory(); api.toast('카테고리를 저장했어요.');
    });
    $('#delete-plan').addEventListener('click', () => {
      if (!editingPlan || !confirm('오늘 이후의 플랜을 삭제할까요? 과거 시간표와 완료 기록은 유지돼요.')) return;
      const id = editingPlan.id;
      api.mutate(({ records }) => Object.assign(records.find((item) => item.id === id), { deletedFrom: state().today, ...stamp() }));
      $('#plan-dialog').close(); api.toast('플랜을 삭제했어요.');
    });
    $('#delete-event').addEventListener('click', () => {
      if (!editingEvent || !confirm('이 일정과 반복되는 일정 전체를 삭제할까요?')) return;
      const id = editingEvent.id;
      api.mutate(({ records }) => Object.assign(records.find((item) => item.id === id), { deleted: true, ...stamp() }));
      $('#event-dialog').close(); api.toast('일정을 삭제했어요.');
    });
    $('#new-event').addEventListener('click', () => openEvent());
    document.addEventListener('change', (event) => {
      if (event.target.id === 'week-jump-date' && schedule.validDate(event.target.value)) api.selectDate(event.target.value, 'overview');
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-planner-action]'); if (!button) return;
      const { plannerAction: action, id, day } = button.dataset;
      if (action === 'new-plan-at' && event.target.closest('.week-block')) return;
      switch (action) {
        case 'close': $(`#${button.dataset.dialog}`).close(); break;
        case 'categories': resetCategory(); renderCategories(); show('category-dialog'); break;
        case 'edit-category': {
          const item = category(id); if (!item) break; editingCategory = id;
          $('#category-name').value = item.name; $('#category-color').value = color(id); $('#category-save').textContent = '수정 저장'; $('#category-error').textContent = ''; break;
        }
        case 'delete-category': {
          if (!confirm('카테고리를 삭제할까요? 연결된 할 일과 플랜은 유지되고 카테고리 지정만 해제돼요.')) break;
          api.mutate(({ records, tasks, routines }) => {
            Object.assign(records.find((item) => item.id === id), { deleted: true, ...stamp() });
            [...records, ...tasks, ...routines].filter((item) => item.categoryId === id).forEach((item) => Object.assign(item, { categoryId: '', ...stamp() }));
          }); resetCategory(); break;
        }
        case 'new-plan': openPlan(); break;
        case 'edit-plan': openPlan(id); break;
        case 'toggle-plan-history': api.mutate(({ records }) => Object.assign(records.find((item) => item.id === id && item.type === 'plan'), { showInCalendar: event.target.checked, ...stamp() })); break;
        case 'new-plan-at': {
          const offset = event.clientY - button.getBoundingClientRect().top;
          const offsets = button.dataset.offsets.split(',').map(Number);
          const index = Math.max(0, offsets.findIndex((position) => position > offset) - 1);
          const start = Math.max(0, Math.min(1410, Number(button.dataset.begin) + Math.floor(index / 2) * 30));
          openPlan(null, day, start); break;
        }
        case 'plan-check': togglePlan(id, day); break;
        case 'new-event': openEvent(); break;
        case 'edit-event': openEvent(id); break;
        case 'prev-week': api.selectDate(core.addDays(state().selectedDate, -7), 'overview'); break;
        case 'next-week': api.selectDate(core.addDays(state().selectedDate, 7), 'overview'); break;
        case 'this-week': api.selectDate(state().today, 'overview'); break;
        case 'select-day': api.selectDate(day, 'overview'); break;
        case 'new-task-day': api.openTask(day); break;
      }
    });
  }
  window.TodoPlanner = { init(options) { api = options; addDialogs(); bindForms(); }, prepare, render, fillCategories, categoryBadge: badge, calendarInfo, renderCalendarHistory, dayPlans, dayPlanCard };
})();
