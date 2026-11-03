import type { Message, MessageType, PayloadOf } from '@ce/protocol';
import type { ServerContext } from '../context';
import type { FixtureMuse } from '../muse/adapter';
import { ProjectService } from './service';
import { ProjectStore } from './store';
import { registerProjectFixture } from './fixture';

/** Independent software-app lane: no agent, driver, executor or physical capability reference. */
export function createProjects(ctx: ServerContext, file?: string): { service: ProjectService; close(): void } {
  if ('register' in ctx.muse) registerProjectFixture(ctx.muse as FixtureMuse);
  const localReaders = new Set<string>();
  const publish = <T extends MessageType>(type: T, payload: PayloadOf<T>) => {
    for (const device of ctx.hub.devices()) if (device.online && (device.canApprove || localReaders.has(device.deviceId))) ctx.hub.sendToDevice(device.deviceId, type, payload);
  };
  const store = new ProjectStore(file);
  const service = new ProjectService({ muse: ctx.muse, store, log: ctx.log,
    send: (sender, state) => ctx.hub.sendToDevice(sender, 'project.state', state),
    broadcast: (state) => publish('project.state', state), catalog: (catalog) => publish('project.catalog', catalog) });
  const previewSockets = new Map<string, { ws: import('ws').WebSocket; close: () => void }>();
  for (const warning of store.warnings) ctx.log(`[projects] ${warning}`);
  const offMessage = ctx.hub.onMessage(({ message, device, connection }) => {
    if (!message.type.startsWith('project.')) return;
    const m = message as Message;
    if (!device.canApprove && !connection.local) {
      ctx.hub.sendToDevice(device.deviceId, 'log', { level: 'error', code: 'forbidden', message: 'Muse Canvas needs a paired Quest or Mac owner.', ref: m.id }); return;
    }
    if (connection.local) localReaders.add(device.deviceId);
    switch (m.type) {
      case 'project.list': ctx.hub.sendToDevice(device.deviceId, 'project.catalog', service.catalog()); break;
      case 'project.get': service.get(device.deviceId, m.payload.projectId); break;
      case 'project.request': void service.request(device.deviceId, m.payload); break;
      case 'project.preset': service.preset(device.deviceId, m.payload); break;
      case 'project.action': service.action(device.deviceId, m.payload); break;
      case 'project.cancel': service.cancel(device.deviceId, m.payload.projectId, m.payload.requestId); break;
      case 'project.preview': {
        if (!previewSockets.has(connection.clientId)) {
          const close = () => { service.disconnectPreview(connection.clientId); previewSockets.delete(connection.clientId); };
          previewSockets.set(connection.clientId, { ws: connection.ws, close }); connection.ws.once('close', close);
        }
        service.preview(connection.clientId, m.payload); break;
      }
    }
  });
  const offPresence = ctx.hub.onPresence((presence) => {
    if (!presence.deviceId) return;
    if (presence.reason === 'revoked' || presence.reason === 'leave' && !presence.devices.some((d) => d.deviceId === presence.deviceId && d.online)) { service.disconnect(presence.deviceId); localReaders.delete(presence.deviceId); }
  });
  return { service, close: () => { for (const { ws, close } of previewSockets.values()) ws.off('close', close); previewSockets.clear(); offMessage(); offPresence(); service.close(); } };
}
