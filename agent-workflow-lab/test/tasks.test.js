import test from "node:test";
import assert from "node:assert/strict";
import {
  addTask,
  completeTask,
  formatTask,
  parseTaskLine,
  summarizeTasks
} from "../src/tasks.js";

test("parses task lines", () => {
  assert.deepEqual(parseTaskLine("[ ] Write tests"), {
    done: false,
    title: "Write tests"
  });
  assert.deepEqual(parseTaskLine("[x] Ship it"), {
    done: true,
    title: "Ship it"
  });
});

test("adds and completes tasks", () => {
  const tasks = addTask([], "Try pi");
  assert.equal(formatTask(tasks[0]), "[ ] Try pi");

  const nextTasks = completeTask(tasks, 0);
  assert.equal(formatTask(nextTasks[0]), "[x] Try pi");
});

test("summarizes tasks", () => {
  const tasks = [
    { done: true, title: "One" },
    { done: false, title: "Two" }
  ];

  assert.deepEqual(summarizeTasks(tasks), {
    total: 2,
    done: 1,
    open: 1
  });
});
