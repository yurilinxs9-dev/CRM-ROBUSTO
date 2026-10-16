'use client';

import { KanbanWorkspace } from '@/components/kanban/kanban-workspace';
import { PL_PIPELINE_ID } from '@/lib/pl-sales';

export default function ConsorcioPlPage() {
  return <KanbanWorkspace fixedPipelineId={PL_PIPELINE_ID} />;
}
