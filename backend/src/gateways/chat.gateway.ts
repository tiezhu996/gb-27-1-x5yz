import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../modules/auth/auth.service';
import { LiveRoomService } from '../modules/live-classes/live-room.service';
import { User } from '../common/entities/user.entity';

@WebSocketGateway({ cors: true, namespace: '/chat' })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly authService: AuthService,
    private readonly liveRoomService: LiveRoomService,
  ) {}

  afterInit(server: Server) {
    this.liveRoomService.setServer(server);
  }

  async handleConnection(client: Socket) {
    try {
      const token =
        (client.handshake.auth?.token as string) || (client.handshake.query?.token as string);
      const payload = await this.jwtService.verifyAsync(token);
      const user = await this.authService.validateUser(payload.sub);
      if (!user) {
        throw new Error('user not found');
      }
      client.data.user = user;
    } catch {
      client.emit('unauthorized', { message: '登录状态无效，请重新登录' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    const result = this.liveRoomService.leaveBySocket(client.id);
    if (result?.fullyLeft) {
      this.server.to(result.roomId).emit('userLeft', {
        userId: result.member.userId,
        userName: result.member.name,
      });
    }
  }

  @SubscribeMessage('joinLive')
  async handleJoinLive(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const user = client.data.user as User;
    if (!user || !data?.roomId) {
      return { ok: false, code: 'UNAUTHORIZED', message: '登录状态无效，请重新登录' };
    }

    const result = await this.liveRoomService.join(data.roomId, user, client.id);
    if (!result.ok) {
      return result;
    }

    client.join(data.roomId);
    if (result.isNewMember) {
      client.to(data.roomId).emit('userJoined', {
        userId: user.id,
        userName: user.name,
      });
    }
    return result;
  }

  @SubscribeMessage('leaveLive')
  handleLeaveLive(@ConnectedSocket() client: Socket) {
    const result = this.liveRoomService.leaveBySocket(client.id);
    if (!result) return;

    client.leave(result.roomId);
    if (result.fullyLeft) {
      this.server.to(result.roomId).emit('userLeft', {
        userId: result.member.userId,
        userName: result.member.name,
      });
    }
  }

  @SubscribeMessage('sendMessage')
  handleMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; message: string },
  ) {
    const user = client.data.user as User;
    if (!user || !data?.roomId || !this.liveRoomService.isInRoom(data.roomId, user.id)) {
      return;
    }

    this.server.to(data.roomId).emit('message', {
      id: `${Date.now()}-${client.id}`,
      userId: user.id,
      userName: user.name,
      message: data.message,
      timestamp: new Date(),
    });
  }

  @SubscribeMessage('raiseHand')
  handleRaiseHand(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const user = client.data.user as User;
    if (!user || !data?.roomId || !this.liveRoomService.isInRoom(data.roomId, user.id)) {
      return;
    }

    this.server.to(data.roomId).emit('handRaised', {
      userId: user.id,
      userName: user.name,
      timestamp: new Date(),
    });
  }

  @SubscribeMessage('lowerHand')
  handleLowerHand(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string },
  ) {
    const user = client.data.user as User;
    if (!user || !data?.roomId || !this.liveRoomService.isInRoom(data.roomId, user.id)) {
      return;
    }

    this.server.to(data.roomId).emit('handLowered', {
      userId: user.id,
    });
  }

  @SubscribeMessage('whiteboardDraw')
  handleWhiteboardDraw(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomId: string; action: any },
  ) {
    const user = client.data.user as User;
    if (!user || !data?.roomId || !this.liveRoomService.isInRoom(data.roomId, user.id)) {
      return;
    }

    client.to(data.roomId).emit('whiteboardUpdate', data.action);
  }
}
