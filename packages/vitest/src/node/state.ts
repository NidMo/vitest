import type { File, Task, TaskResultPack, UserConsoleLog } from '../types'

/**
 * 文件状态管理器
 */
export class StateManager {
  filesMap = new Map<string, File>()
  idMap = new Map<string, Task>()
  taskFileMap = new WeakMap<Task, File>()

  /**
   * 根据keys获取文件集合
   * @param keys
   * @returns
   */
  getFiles(keys?: string[]): File[] {
    if (keys)
      return keys.map(key => this.filesMap.get(key)!)
    return Array.from(this.filesMap.values())
  }

  /**
   * 获取文件路径集合
   * @returns
   */
  getFilepaths(): string[] {
    return Array.from(this.filesMap.keys())
  }

  /**
   * 获取状态失败的文件路径集合
   * @returns
   */
  getFailedFilepaths() {
    return this.getFiles()
      .filter(i => i.result?.state === 'fail')
      .map(i => i.filepath)
  }

  /**
   * 收集文件集合
   * @param files
   * @description 收集文件，文件路径作为key，文件作为value，并更新id
   */
  collectFiles(files: File[] = []) {
    files.forEach((file) => {
      this.filesMap.set(file.filepath, file)
      this.updateId(file)
    })
  }

  /**
   * 更新Id
   * @param task
   * @returns
   */
  updateId(task: Task) {
    if (this.idMap.get(task.id) === task)
      return
    this.idMap.set(task.id, task)
    if (task.type === 'suite') {
      task.tasks.forEach((task) => {
        this.updateId(task)
      })
    }
  }

  /**
   * 更新任务
   * @param packs
   * @description 写入任务结果
   */
  updateTasks(packs: TaskResultPack[]) {
    for (const [id, result] of packs) {
      if (this.idMap.has(id))
        this.idMap.get(id)!.result = result
    }
  }

  /**
   * 更新用户日志
   * @param log
   * @description 根据log中的taskId，写入到任务
   */
  updateUserLog(log: UserConsoleLog) {
    const task = log.taskId && this.idMap.get(log.taskId)
    if (task) {
      if (!task.logs)
        task.logs = []
      task.logs.push(log)
    }
  }
}
