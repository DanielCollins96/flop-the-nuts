import { resolve } from "node:path";
import { addTask, completeTask, summarizeTasks, formatTask } from "./tasks.js";
import { loadTasks, saveTasks } from "./store.js";

const [command, ...args] = process.argv.slice(2);
const taskFile = resolve("tasks.txt");

function usage() {
  console.log("Usage:");
  console.log("  npm start -- add <title>");
  console.log("  npm start -- done <number>");
  console.log("  npm start -- list");
  console.log("  npm start -- summary");
}

async function main() {
  const tasks = await loadTasks(taskFile);

  if (command === "add") {
    const nextTasks = addTask(tasks, args.join(" "));
    await saveTasks(taskFile, nextTasks);
    console.log(`Added task ${nextTasks.length}`);
    return;
  }

  if (command === "done") {
    const taskNumber = Number.parseInt(args[0], 10);
    const nextTasks = completeTask(tasks, taskNumber - 1);
    await saveTasks(taskFile, nextTasks);
    console.log(`Completed task ${taskNumber}`);
    return;
  }

  if (command === "list") {
    tasks.forEach((task, index) => {
      console.log(`${index + 1}. ${formatTask(task)}`);
    });
    return;
  }

  if (command === "summary") {
    const summary = summarizeTasks(tasks);
    console.log(`${summary.done}/${summary.total} done, ${summary.open} open`);
    return;
  }

  usage();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
