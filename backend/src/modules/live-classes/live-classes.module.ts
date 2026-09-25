import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LiveClass } from '../../common/entities/live-class.entity';
import { CourseEnrollment } from '../../common/entities/course-enrollment.entity';
import { User } from '../../common/entities/user.entity';
import { LiveClassesController } from './live-classes.controller';
import { LiveClassesService } from './live-classes.service';
import { ChatGateway } from '../../gateways/chat.gateway';

@Module({
  imports: [
    TypeOrmModule.forFeature([LiveClass, CourseEnrollment, User]),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET', 'secret'),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [LiveClassesController],
  providers: [LiveClassesService, ChatGateway],
  exports: [LiveClassesService],
})
export class LiveClassesModule {}
