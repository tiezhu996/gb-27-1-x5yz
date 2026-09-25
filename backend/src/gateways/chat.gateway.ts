import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { Logger } from '@nestjs/common';
import { LiveClassesService } from '../modules/live-classes/live-classes.service';
import { UserRole } from '../common/entities/user.entity';

interface AuthenticatedSocket extends Socket {
  userId?: string;
}

/** 心跳参数：掉线约 pingInterval + pingTimeout（约 20s）内被发现，及时释放名额 */
@WebSocketGateway({
  cors: true,
  namespace: '/chat',
  pingInterval: 10000,
  pingTimeout: 10000,
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server: Server;

  constructor(
    private readonly liveClassesService: LiveClassesService,
    private readonly jwtService: JwtService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    // 连接阶段只做身份认证，不再自动加入任何房间，杜绝"拿到链接就能进"
    const token =
      (client.handshake.auth?.token as string | undefined) ||
      (client.handshake.query?.token as string | undefined);

    if (!token) {
      client.emit('authError', { code: 'unauthorized', message: '未登录' });
      client.disconnect(true);
      return;
    }

    try {
      const payload = this.jwtService.verify(token);
      const user = await this.liveClassesService.findUserById(payload.sub);
      if (!user) {
        client.emit('authError', { code: 'unauthorized', message: '用户不存在' });
        client.disconnect(true);
        return;
      }
      client.userId = user.id;
      client.data.user = user;
      client.emit('authed', { userId: user.id });
    } catch {
      client.emit('authError', { code: 'unauthorized', message: '登录已过期' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    this.leaveBySocket(client);
  }

  /**
   * 进入课堂的唯一通道。资格、开播状态、容量全部由服务端校验，
   * 校验通过才真正 join socket.io 房间并占用名额。
   */
  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ) {
    const user = client.data.user;
    const roomId = data?.roomId;
    if (!user || !roomId) {
      client.emit('joinError', { code: 'unauthorized', message: '请先登录' });
      return;
    }

    const result = await this.liveClassesService.admit(roomId, client.id, user);
    if (result.ok === false) {
      client.emit('joinError', { code: result.code, message: result.message });
      return;
    }

    client.join(roomId);
    client.emit('joinedRoom', {
      liveClassId: roomId,
      presence: result.presence,
    });

    if (!result.rejoined) {
      this.server.to(roomId).emit('userJoined', {
        userId: user.id,
        userName: user.name,
        role: result.presence.users.find((u) => u.userId === user.id)?.role,
      });
    }
    this.server.to(roomId).emit('presenceUpdate', result.presence);
  }

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ) {
    const roomId = data?.roomId;
    if (roomId) client.leave(roomId);
    // 主动离开（页面跳转/关闭）立即释放名额
    const released = this.liveClassesService.release(client.id);
    if (released) {
      this.server.to(released.liveClassId).emit('userLeft', {
        userId: released.removedUser.userId,
        userName: released.removedUser.userName,
        role: released.removedUser.role,
      });
      this.server.to(released.liveClassId).emit('presenceUpdate', released.presence);
    }
  }

  private leaveBySocket(client: AuthenticatedSocket) {
    const released = this.liveClassesService.release(client.id);
    if (!released) return;

    this.server.to(released.liveClassId).emit('userLeft', {
      userId: released.removedUser.userId,
      userName: released.removedUser.userName,
      role: released.removedUser.role,
    });
    this.server.to(released.liveClassId).emit('presenceUpdate', released.presence);
  }

  @SubscribeMessage('sendMessage')
  handleMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string; message: string },
  ) {
    const { roomId, message } = data || {};
    const user = client.data.user;
    if (!roomId || !user || !this.clientIsMember(client, roomId)) return;

    this.server.to(roomId).emit('message', {
      id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
      userId: user.id,
      userName: user.name,
      message,
      timestamp: new Date(),
    });
  }

  @SubscribeMessage('raiseHand')
  handleRaiseHand(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ) {
    const roomId = data?.roomId;
    const user = client.data.user;
    if (!roomId || !user || !this.clientIsMember(client, roomId)) return;

    this.server.to(roomId).emit('handRaised', {
      userId: user.id,
      userName: user.name,
      timestamp: new Date(),
    });
  }

  @SubscribeMessage('lowerHand')
  handleLowerHand(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string },
  ) {
    const roomId = data?.roomId;
    const user = client.data.user;
    if (!roomId || !user || !this.clientIsMember(client, roomId)) return;

    this.server.to(roomId).emit('handLowered', { userId: user.id });
  }

  @SubscribeMessage('whiteboardDraw')
  handleWhiteboardDraw(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() data: { roomId: string; action: unknown },
  ) {
    const { roomId, action } = data || {};
    if (!roomId || !this.clientIsMember(client, roomId)) return;
    this.server.to(roomId).emit('whiteboardUpdate', action);
  }

  /** 课堂结束：广播空名单（人数归零）与结束事件，然后断开所有人的连接 */
  broadcastClassEnded(liveClassId: string, maxParticipants: number, socketIds: string[]) {
    const emptyPresence = this.liveClassesService.buildEmptyPresence(liveClassId, maxParticipants);
    this.server.to(liveClassId).emit('presenceUpdate', emptyPresence);
    this.server.to(liveClassId).emit('classEnded', { liveClassId });
    for (const socketId of socketIds) {
      const socket = this.server.sockets.sockets.get(socketId);
      socket?.disconnect(true);
    }
  }

  private clientIsMember(client: Socket, roomId: string): boolean {
    return client.rooms.has(roomId);
  }
}
