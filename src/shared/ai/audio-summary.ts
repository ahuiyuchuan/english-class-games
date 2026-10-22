/** 固定制作输入的真实声音成果计数；可供后续游戏复用，不引用节拍参数。 @author ahui */

/** 相同需求只计一次；ready 表示任务启动时已有匹配且登记的素材。 */
export interface AudioProductionRequirement {
  key: string;
  objectId: string;
  ready: boolean;
}

/** 只接纳真实完成的产物；cached 表示本次任务实际命中了有效缓存。 */
export interface AudioProductionSuccess {
  objectId: string;
  cached?: boolean;
}

/** 三类互斥且合计等于total；失败是unfinished的子集，由任务详情另列。 */
export interface AudioProductionSummary {
  total: number;
  created: number;
  reused: number;
  unfinished: number;
}

/**
 * 按固定输入的唯一需求合并：已有声音或任务内命中缓存均算复用，实际合成算新制作。
 * 未成功和取消项留在未完成；同一声音被多个词条引用不会放大成果。
 * @param requirements 本次任务固定输入的声音需求；相同key表示相同声音。
 * @param successes 同一任务已实际成功的产物，缺省表示尚无完成结果。
 * @returns 三类互斥数量及总数；created+reused+unfinished始终等于total。
 */
export function summarizeAudioProduction(
  requirements: AudioProductionRequirement[],
  successes: AudioProductionSuccess[] = [],
): AudioProductionSummary {
  const groups = new Map<string, AudioProductionRequirement[]>();
  for (const requirement of requirements) {
    const group = groups.get(requirement.key) ?? [];
    group.push(requirement);
    groups.set(requirement.key, group);
  }
  const summary = { total: groups.size, created: 0, reused: 0, unfinished: 0 };
  for (const group of groups.values()) {
    const results = successes.filter((result) =>
      group.some((item) => item.objectId === result.objectId),
    );
    if (group.some((item) => item.ready) || results.some((result) => result.cached))
      summary.reused += 1;
    else if (results.length) summary.created += 1;
    else summary.unfinished += 1;
  }
  return summary;
}
