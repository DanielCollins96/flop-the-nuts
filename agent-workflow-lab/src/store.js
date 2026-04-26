import { readFile, writeFile } from "node:fs/promises";
import { parseTaskLine, formatTask } from "./tasks.js";

export async function loadTasks(filePath) {
  try {
    const content = await readFile(filePath, "utf8");
    return content
      .split("\n")
      .map(parseTaskLine)
      .filter(Boolean);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

export async function saveTasks(filePath, tasks) {
  const content = tasks.map(formatTask).join("\n");
  await writeFile(filePath, content ? `${content}\n` : "", "utf8");
}
