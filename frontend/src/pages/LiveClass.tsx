import {
  Button,
  Input,
  Card,
  Typography,
  Tag,
  Space,
  message,
  Avatar,
  List,
  Spin,
  Result,
  Alert,
} from 'antd';
import {
  ArrowLeftOutlined,
  CheckCircleOutlined,
  LikeOutlined,
  TeamOutlined,
  CrownOutlined,
} from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { liveClassApi, attendanceApi } from '@/api/live';
import {
  LiveClass as LiveClassType,
  LiveClassStatus,
  PresenceSnapshot,
  JoinErrorCode,
} from '@/types/live';
import { useAuthStore } from '@/store/auth';
import { UserRole } from '@/types/user';

const { Title, Text } = Typography;

interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  message: string;
  timestamp: Date;
}

type JoinState =
  | 'connecting'
  | 'joined'
  | 'waiting'
  | 'full'
  | 'denied'
  | 'ended';

const WAIT_POLL_INTERVAL = 5000;
const FULL_RETRY_INTERVAL = 10000;

export default function LiveClass() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [liveClass, setLiveClass] = useState<LiveClassType | null>(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [handRaised, setHandRaised] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const [joinState, setJoinState] = useState<JoinState>('connecting');
  const [denyReason, setDenyReason] = useState<{ code?: JoinErrorCode; message: string }>({
    message: '',
  });
  const [presence, setPresence] = useState<PresenceSnapshot | null>(null);
  const { user, accessToken } = useAuthStore();
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const joinStateRef = useRef<JoinState>('connecting');
  joinStateRef.current = joinState;

  const isTeacher = user?.role === UserRole.TEACHER;

  const joinRoom = () => {
    if (id && socketRef.current?.connected) {
      socketRef.current.emit('joinRoom', { roomId: id });
    }
  };

  const appendSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
        userId: 'system',
        userName: '系统',
        message: text,
        timestamp: new Date(),
      },
    ]);
  };

  useEffect(() => {
    if (!id) return;
    let disposed = false;

    const load = async () => {
      setLoading(true);
      try {
        const data = await liveClassApi.get(id);
        if (!disposed) setLiveClass(data);
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    load();

    if (!accessToken) {
      setJoinState('denied');
      setDenyReason({ code: 'unauthorized', message: '请先登录后再进入直播间' });
      setLoading(false);
      return () => {
        disposed = true;
      };
    }

    const socket = io('/socket.io/chat', {
      auth: { token: accessToken },
      transports: ['websocket', 'polling'],
    });
    socketRef.current = socket;

    socket.on('authed', () => {
      // 认证通过后才请求进入；断线重连会重新触发，服务端幂等处理（rejoined）
      socket.emit('joinRoom', { roomId: id });
    });

    socket.on('authError', (data: { code: JoinErrorCode; message: string }) => {
      setJoinState('denied');
      setDenyReason({ code: data.code, message: data.message });
    });

    socket.on('joinedRoom', (data: { presence: PresenceSnapshot }) => {
      setJoinState('joined');
      setDenyReason({ message: '' });
      setPresence(data.presence);
    });

    socket.on('joinError', (data: { code: JoinErrorCode; message: string }) => {
      if (data.code === 'not_live') {
        setJoinState('waiting');
        setDenyReason({ message: data.message });
      } else if (data.code === 'class_full') {
        setJoinState('full');
        setDenyReason({ message: data.message });
      } else {
        setJoinState('denied');
        setDenyReason({ code: data.code, message: data.message });
      }
    });

    socket.on('presenceUpdate', (snapshot: PresenceSnapshot) => {
      setPresence(snapshot);
    });

    socket.on('userJoined', (data: { userName: string }) => {
      appendSystemMessage(`${data.userName || '某用户'} 进入了直播间`);
    });

    socket.on('userLeft', (data: { userName: string }) => {
      appendSystemMessage(`${data.userName || '某用户'} 离开了直播间`);
    });

    socket.on('classEnded', () => {
      setJoinState('ended');
      setLiveClass((prev) =>
        prev ? { ...prev, status: LiveClassStatus.ENDED } : prev,
      );
      message.info('直播已结束');
    });

    socket.on('handRaised', (data: { userName: string }) => {
      appendSystemMessage(`${data.userName} 举手了`);
    });

    socket.on('handLowered', () => {
      appendSystemMessage('有用户放下了手');
    });

    socket.on('message', (msg: ChatMessage) => {
      setMessages((prev) => [...prev, msg]);
    });

    // 等待开播：轮询课堂状态，开播后自动请求进入
    const waitTimer = setInterval(async () => {
      if (joinStateRef.current !== 'waiting') return;
      try {
        const data = await liveClassApi.get(id);
        setLiveClass(data);
        if (data.status === LiveClassStatus.LIVE) {
          socket.emit('joinRoom', { roomId: id });
        }
      } catch {
        // 忽略轮询错误，下一轮继续
      }
    }, WAIT_POLL_INTERVAL);

    // 课堂已满：定时重试，有人离开后自动补位
    const fullTimer = setInterval(() => {
      if (joinStateRef.current !== 'full') return;
      socket.emit('joinRoom', { roomId: id });
    }, FULL_RETRY_INTERVAL);

    const leaveRoom = () => {
      // 正常跳转/关闭组件时主动离开，立即释放名额
      socket.emit('leaveRoom', { roomId: id });
      socket.disconnect();
    };

    return () => {
      disposed = true;
      clearInterval(waitTimer);
      clearInterval(fullTimer);
      leaveRoom();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const sendMessage = () => {
    if (!inputMessage.trim() || !socketRef.current || joinState !== 'joined') return;
    socketRef.current.emit('sendMessage', {
      roomId: id,
      message: inputMessage,
    });
    setInputMessage('');
  };

  const toggleHand = () => {
    if (!socketRef.current || joinState !== 'joined') return;
    if (handRaised) {
      socketRef.current.emit('lowerHand', { roomId: id });
    } else {
      socketRef.current.emit('raiseHand', { roomId: id });
    }
    setHandRaised(!handRaised);
  };

  const handleCheckIn = async () => {
    if (!id) return;
    try {
      await attendanceApi.checkIn(id);
      setCheckedIn(true);
      message.success('签到成功');
    } catch (error: any) {
      message.error(error.response?.data?.message || '签到失败');
    }
  };

  const startLive = async () => {
    if (!id) return;
    try {
      const updated = await liveClassApi.start(id);
      setLiveClass(updated);
      message.success('直播已开始');
    } catch (error: any) {
      message.error(error.response?.data?.message || '开始直播失败');
    }
  };

  const endLive = async () => {
    if (!id) return;
    try {
      const updated = await liveClassApi.end(id);
      setLiveClass(updated);
      setJoinState('ended');
      message.success('直播已结束');
    } catch (error: any) {
      message.error(error.response?.data?.message || '结束直播失败');
    }
  };

  const getStatusTag = (status: LiveClassStatus) => {
    switch (status) {
      case LiveClassStatus.LIVE:
        return <Tag color="red">直播中</Tag>;
      case LiveClassStatus.SCHEDULED:
        return <Tag color="blue">未开始</Tag>;
      case LiveClassStatus.ENDED:
        return <Tag color="default">已结束</Tag>;
    }
  };

  if (loading) {
    return (
      <Card>
        <div style={{ textAlign: 'center', padding: 50 }}>
          <Spin tip="加载中..." />
        </div>
      </Card>
    );
  }

  const renderEntryBlocked = () => {
    if (joinState === 'connecting') {
      return (
        <Result
          icon={<Spin />}
          title="正在进入直播间..."
          subTitle="正在校验进入资格与名额"
        />
      );
    }
    if (joinState === 'waiting') {
      return (
        <Result
          icon={<Spin />}
          title="直播尚未开始"
          subTitle="开播后将自动进入课堂，请稍候"
          extra={
            isTeacher ? null : (
              <Alert
                type="info"
                showIcon
                message="仅在教师开播后放行，页面会自动重试"
                style={{ maxWidth: 360, margin: '0 auto' }}
              />
            )
          }
        />
      );
    }
    if (joinState === 'full') {
      return (
        <Result
          status="warning"
          icon={<TeamOutlined />}
          title="课堂已满"
          subTitle={`当前学生名额已达上限（${presence?.maxParticipants ?? liveClass?.maxParticipants ?? '-'} 人），有人离开后将自动补位...`}
          extra={
            <Space direction="vertical">
              <Spin size="small" />
              <Button type="primary" onClick={joinRoom}>
                立即重试
              </Button>
            </Space>
          }
        />
      );
    }
    if (joinState === 'denied') {
      return (
        <Result
          status="403"
          title="无法进入直播间"
          subTitle={denyReason.message}
          extra={
            <Space>
              {denyReason.code === 'unauthorized' && (
                <Button type="primary" onClick={() => navigate('/login')}>
                  去登录
                </Button>
              )}
              <Button onClick={() => navigate(-1)}>返回</Button>
            </Space>
          }
        />
      );
    }
    if (joinState === 'ended') {
      return (
        <Result
          status="info"
          title="课堂已结束"
          subTitle="本次直播的在线人数已清零"
          extra={<Button onClick={() => navigate(-1)}>返回</Button>}
        />
      );
    }
    return null;
  };

  const roomReady = joinState === 'joined';

  return (
    <div>
      <Space style={{ marginBottom: 16 }}>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
          返回
        </Button>
        <Title level={3} style={{ margin: 0 }}>
          {liveClass?.title}
        </Title>
        {liveClass && getStatusTag(liveClass.status)}
        {roomReady && presence && (
          <Tag icon={<TeamOutlined />} color="blue">
            在线 {presence.onlineCount} 人（学生 {presence.studentCount}/
            {presence.maxParticipants}）
          </Tag>
        )}
      </Space>

      {!roomReady ? (
        <Card>{renderEntryBlocked()}</Card>
      ) : (
        <div className="live-container">
          <div className="live-video-area">
            <div style={{ textAlign: 'center' }}>
              <Title level={2} style={{ color: 'white' }}>直播区域</Title>
              <Text style={{ color: 'white', opacity: 0.7 }}>
                {liveClass?.status === LiveClassStatus.LIVE
                  ? '直播进行中...'
                  : '等待直播开始...'}
              </Text>
              <div style={{ marginTop: 24 }}>
                <Space>
                  {isTeacher && liveClass?.status === LiveClassStatus.SCHEDULED && (
                    <Button type="primary" size="large" onClick={startLive}>
                      开始直播
                    </Button>
                  )}
                  {isTeacher && liveClass?.status === LiveClassStatus.LIVE && (
                    <Button type="primary" danger size="large" onClick={endLive}>
                      结束直播
                    </Button>
                  )}
                  {!isTeacher &&
                    liveClass?.status === LiveClassStatus.LIVE &&
                    !checkedIn && (
                      <Button
                        type="primary"
                        size="large"
                        icon={<CheckCircleOutlined />}
                        onClick={handleCheckIn}
                      >
                        签到
                      </Button>
                    )}
                </Space>
              </div>
            </div>
          </div>

          <div className="live-sidebar">
            {/* 在线人数与名单（教师可见完整名单，学生只见人数） */}
            <Card
              size="small"
              title={
                <Space>
                  <TeamOutlined />
                  <span>在线人数：{presence?.onlineCount ?? 0}</span>
                  <Tag color="blue">
                    学生 {presence?.studentCount ?? 0}/{presence?.maxParticipants ?? '-'}
                  </Tag>
                </Space>
              }
              style={{ maxHeight: 260, overflow: 'auto', marginBottom: 8 }}
              styles={{ body: { padding: isTeacher ? 8 : 12 } }}
            >
              {isTeacher ? (
                <List
                  size="small"
                  dataSource={presence?.users ?? []}
                  rowKey={(u) => u.userId}
                  renderItem={(u) => (
                    <List.Item>
                      <Space>
                        <Avatar size="small" style={{ background: '#1890ff' }}>
                          {u.userName?.[0]}
                        </Avatar>
                        <Text>{u.userName}</Text>
                        {u.role === UserRole.TEACHER ? (
                          <Tag color="gold" icon={<CrownOutlined />}>
                            教师
                          </Tag>
                        ) : (
                          <Tag>学生</Tag>
                        )}
                      </Space>
                    </List.Item>
                  )}
                />
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  在线名单仅授课教师可见
                </Text>
              )}
            </Card>

            <Card
              title="互动聊天"
              size="small"
              style={{ flex: 1, display: 'flex', flexDirection: 'column' }}
            >
              <div className="chat-messages">
                {messages.map((msg) => (
                  <div key={msg.id} className="chat-message">
                    <Space>
                      <Avatar size="small" style={{ background: '#1890ff' }}>
                        {msg.userName?.[0]}
                      </Avatar>
                      <div>
                        <Text strong>{msg.userName}</Text>
                        <div style={{ fontSize: 14 }}>{msg.message}</div>
                      </div>
                    </Space>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>
              <div className="chat-input">
                <Space.Compact style={{ width: '100%' }}>
                  <Input
                    placeholder="输入弹幕消息..."
                    value={inputMessage}
                    onChange={(e) => setInputMessage(e.target.value)}
                    onPressEnter={sendMessage}
                  />
                  <Button type="primary" onClick={sendMessage}>
                    发送
                  </Button>
                </Space.Compact>
                <div style={{ marginTop: 12 }}>
                  <Space>
                    <Button
                      type={handRaised ? 'primary' : 'default'}
                      icon={<LikeOutlined />}
                      onClick={toggleHand}
                      disabled={liveClass?.status !== LiveClassStatus.LIVE}
                    >
                      {handRaised ? '放下手' : '举手'}
                    </Button>
                  </Space>
                </div>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
