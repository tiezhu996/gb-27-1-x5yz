import { Controller, Get, Post, Param, Body, UseGuards, Request } from '@nestjs/common';
import { LiveClassesService } from './live-classes.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatGateway } from '../../gateways/chat.gateway';

@Controller('live-classes')
export class LiveClassesController {
  constructor(
    private readonly liveClassesService: LiveClassesService,
    private readonly chatGateway: ChatGateway,
  ) {}

  @Get()
  findAll() {
    return this.liveClassesService.findAll();
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Request() req, @Body() data: any) {
    return this.liveClassesService.create(req.user.id, data);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.liveClassesService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/start')
  startLive(@Param('id') id: string, @Request() req) {
    return this.liveClassesService.startLive(req.user.id, id);
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/end')
  async endLive(@Param('id') id: string, @Request() req) {
    const { liveClass, kickedSocketIds } = await this.liveClassesService.endLive(req.user.id, id);
    // 通知所有在线连接：课堂结束、名单清空，并断开连接
    this.chatGateway.broadcastClassEnded(id, liveClass.maxParticipants, kickedSocketIds);
    return liveClass;
  }
}
