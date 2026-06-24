import type { ToolContext } from "./tool";
import type { ReActLoop, ReActLoopOptions } from "./react-loop";
import { createReActAgent } from "./react-agent";

/**
 * The plain canonical ReAct loop — {@link createReActAgent} with no host-policy
 * hooks. Convenient for new/simple agents: call model -> run tools -> repeat
 * until the model stops requesting tools or the round budget forces one tool-free
 * synthesis. Streams {@link ReActEvent}s; `collectReActRun` drains to the answer.
 */
export function createBasicReActAgent<Ctx extends ToolContext>(
  options: ReActLoopOptions<Ctx>
): ReActLoop<Ctx> {
  return createReActAgent(options);
}

export { DEFAULT_REACT_MAX_ROUNDS, collectReActRun, createReActAgent } from "./react-agent";
