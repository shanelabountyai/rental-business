import { AddTaskForm } from '@/components/tasks/add-task-form.tsx'
import { requireScope } from '@/lib/auth/guard.ts'
import { currentScope } from '@/lib/scope/current-scope.ts'
import { addTask } from '@/lib/tasks/actions.ts'

export const metadata = { title: 'New task — Rental Operations' }

// requireScope, not a bare requirePermission: this is the guard for "may this
// actor create a task ANYWHERE", the same shape as /properties/new. The
// specific property picked in the form is re-checked by addTask() itself.
export default async function NewTaskPage() {
  const { actor } = await requireScope('task.write')
  const scope = await currentScope(actor)

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">New task</h1>
      <p className="text-muted-foreground max-w-prose text-sm">
        An ad-hoc task with no domain event behind it - everything else in
        the queue is created automatically once a later item produces it
        (D-9).
      </p>
      <AddTaskForm
        action={addTask}
        submitLabel="Add task"
        properties={scope.availableProperties}
      />
    </div>
  )
}
