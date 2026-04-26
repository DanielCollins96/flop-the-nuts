export function parseTaskLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const done = trimmed.startsWith("[x]");
  const open = trimmed.startsWith("[ ]");
  if (!done && !open) {
    throw new Error(`Invalid task line: ${line}`);
  }

  return {
    done,
    title: trimmed.slice(3).trim()
  };
}

export function formatTask(task) {
  return `${task.done ? "[x]" : "[ ]"} ${task.title}`;
}

export function addTask(tasks, title) {
  const cleanTitle = title.trim();
  if (!cleanTitle) {
    throw new Error("Task title is required");
  }
  return [...tasks, { done: false, title: cleanTitle }];
}

export function completeTask(tasks, index) {
  if (!Number.isInteger(index) || index < 0 || index >= tasks.length) {
    throw new Error(`Task index out of range: ${index + 1}`);
  }

  return tasks.map((task, taskIndex) =>
    taskIndex === index ? { ...task, done: true } : task
  );
}

export function summarizeTasks(tasks) {
  const done = tasks.filter((task) => task.done).length;
  return {
    total: tasks.length,
    done,
    open: tasks.length - done
  };
}
