/**
 * 任务动作层用到的 api 门面 —— 把 tasks.mjs 的真实导出收成一个对象，
 * 免得动作层直接依赖一堆模块级名字（换实现只改这里）。
 */
import * as T from './tasks.mjs';
import { balance } from './billing.mjs';

export const api = {
  // 任务读取
  listTasks: T.listTasks,
  listTasksMP: T.listTasksMP,
  taskByCode: T.taskByCode,
  taskByCodeMP: T.taskByCodeMP,
  taskByCodeWaiting: T.taskByCodeWaiting,
  isMPTaskCode: T.isMPTaskCode,
  taskProgressText: T.taskProgressText,
  // 接受 / 领奖
  acceptTasks: T.acceptTasks,
  acceptTasksMP: T.acceptTasksMP,
  claimReward: T.claimReward,
  claimRewardMP: T.claimRewardMP,
  acceptWithVerifyMP: T.acceptWithVerifyMP,
  // 小程序口径上报
  reportMPEvent: T.reportMPEvent,
  schoolSeasonChatEvent: T.schoolSeasonChatEvent,
  schoolChatTimesEvents: T.schoolChatTimesEvents,
  // 夜猫子
  blackcatNeed: T.blackcatNeed,
  runNightChats: T.runNightChats,
  inNightWindow: T.inNightWindow,
  // 积分查询（billing 域）
  balance,
};

export * from './tasks.mjs';
