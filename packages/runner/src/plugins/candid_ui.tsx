import { TextInput } from "@inkjs/ui"
import { Effect, Match } from "effect"
import {
  Box,
  render,
  Text
} from "ink"
import React from "react"
import { loadCanisterId } from "../builders/lib.js"
import { Tags } from "../builders/lib.js"
import { TaskCtx } from "../tasks/lib.js"
import type {
  Scope,
  Task,
  TaskTreeNode
} from "../types/types.js"

const CandidUI = ({
  canisterId,
  canisterName,
}: {
  canisterId: string
  canisterName: string
}) => {

  return (
    <Box>
      <Text>{canisterName}</Text>
      <Text>{canisterId}</Text>
      <TextInput placeholder="write value..." onSubmit={() => {}} />
    </Box>
  )
}

type CanisterScope = Scope & {
  children: {
    create: Task
    bindings: Task
    build: Task
    install: Task
  }
}

const makeCandidUITask = (scope: CanisterScope): Task => {
  return {
    _tag: "task",
    // TODO: get from task?
    id: Symbol("canister/candid_ui"),
    dependencies: {},
    dependsOn: {},
    // TODO: do we only want to warn at a type level?
    // TODO: type Task
    effect: Effect.gen(function* () {
      const { runTask, replica, roles } = yield* TaskCtx
      const { identity } = roles.deployer
      const { taskPath } = yield* TaskCtx
      const canisterName = taskPath.split(":").slice(0, -1).join(":")
      const canisterId = yield* loadCanisterId(taskPath)
      // TODO: exits immediately
      render(<CandidUI canisterId={canisterId} canisterName={canisterName} />)
    }),
    description: "Open canister candid ui",
    tags: [Tags.CANISTER, Tags.UI],
    namedParams: {},
    positionalParams: [],
    params: {},
  }
}

const transformScopes = (
  taskTreeNode: TaskTreeNode,
  fn: (scope: Scope) => Scope,
): TaskTreeNode => {
  return Match.value(taskTreeNode).pipe(
    Match.tag("scope", (scope) => {
      const transformedChildren: Record<string, TaskTreeNode> = {}
      for (const [name, child] of Object.entries(scope.children)) {
        transformedChildren[name] = transformScopes(child, fn)
      }
      return fn({
        ...scope,
        children: transformedChildren,
      })
    }),
    Match.tag("builder", (builder) => {
      return {
        ...builder,
        // TODO: remove _scope
        _scope: transformScopes(builder.make(), fn),
      }
    }),
    Match.tag("task", (task) => task),
    Match.orElse(() => taskTreeNode),
  )
}
export const candidUITaskPlugin = (taskTree: TaskTreeNode): TaskTreeNode => {
  return transformScopes(taskTree, (scope) => {
    if (scope.tags.includes(Tags.CANISTER)) {
      const newScope = {
        ...scope,
        children: {
          ...scope.children,
          candid_ui: makeCandidUITask(scope as CanisterScope),
        },
      }
      return newScope
    }
    return scope
  })
}
