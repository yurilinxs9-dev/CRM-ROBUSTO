'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { getSocket } from '@/lib/socket';

interface TaskPayload {
  titulo?: string;
  taskId?: string;
}

export function TaskNotifications() {
  useEffect(() => {
    const socket = getSocket();

    const handleTaskOverdue = (payload: TaskPayload) => {
      toast.warning(`Tarefa atrasada: ${payload.titulo ?? 'sem titulo'}`);
    };

    const handleTaskCreated = (payload: TaskPayload) => {
      toast.info(`Nova tarefa: ${payload.titulo ?? 'sem titulo'}`);
    };

    const handleTaskUpdated = (payload: TaskPayload) => {
      toast.info(`Tarefa atualizada: ${payload.titulo ?? 'sem titulo'}`);
    };

    socket.on('task:overdue', handleTaskOverdue);
    socket.on('task:created', handleTaskCreated);
    socket.on('task:updated', handleTaskUpdated);

    return () => {
      socket.off('task:overdue', handleTaskOverdue);
      socket.off('task:created', handleTaskCreated);
      socket.off('task:updated', handleTaskUpdated);
    };
  }, []);

  return null;
}
