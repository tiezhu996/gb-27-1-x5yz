import { Button, Input, Card, Typography, Tag, Space, message, Avatar, Result, List } from 'antd';
import { ArrowLeftOutlined, CheckCircleOutlined, LikeOutlined, TeamOutlined } from '@ant-design/icons';
import { useParams, useNavigate } from 'react-router-dom';
import { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { liveClassApi, attendanceApi } from '@/api/live';
import {
  LiveClass as LiveClassType,
  LiveClassStatus,
  LiveParticipant,
  JoinLiveResult,
  JoinLiveErrorCode,
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

interface JoinError {
  code: JoinLiveErrorCode;
  message: string;
}

export default function LiveClass() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [liveClass, setLiveClass] = useState<LiveClassType | null>(null);
  const [loading, setLoading] = useState(true);
  const [joined, setJoined] = useState(false);
  const [joinError, setJoinError] = useState<JoinError | null>(null);
  const [myRole, setMyRole] = useState<'teacher' | 'student'>('student');
  const [onlineCount, setOnlineCount] = useState(0);
  const [participants, setParticipants] = useState<LiveParticipant[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [handRaised, setHandRaised] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const { user } = useAuthStore();
  const socketRef = useRef<Socket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isTeacher = user?.role === UserRole.TEACHER;

  const pushSystemMessage = (text: string) => {
    setMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-${Math.random()}`,
        userId: 'system',
        userName: '系统',
        message: text,
        timestamp: new Date(),
      },
    ]);
  };

  const initSocket = useCallback(
    (roomId: string) => {
      const socket = io('/chat', {
        auth: { token: localStorage.getItem('accessToken') },
        transports: ['websocket', 'polling'],
      });
      socketRef.current = socket;

      const attemptJoin = () => {
        socket.emit('joinLive', { roomId }, (result: JoinLiveResult) => {
          if (result.ok) {
            setJoined(true);
            setJoinError(null);
            setMyRole(result.role || 'student');
            setOnlineCount(result.count ?? 0);
            setParticipants(result.participants ?? []);
          } else {
            setJoined(false);
            setJoinError({
              code: result.code || JoinLiveErrorCode.NOT_FOUND,
              message: result.message || '进入课堂失败',
            });
            // 未开播/课堂已满：自动等待，开播或空出名额后直接放行
            if (result.code === JoinLiveErrorCode.NOT_STARTED || result.code === JoinLiveErrorCode.FULL) {
              window.setTimeout(() => {
                if (socket.connected) attemptJoin();
              }, 5000);
            }
          }
        });
      };

      socket.on('connect', attemptJoin);

      socket.on('disconnect', () => {
        setJoined(false);
      });

      socket.on('unauthorized', () => {
        setJoinError({ code: JoinLiveErrorCode.UNAUTHORIZED, message: '登录状态无效，请重新登录' });
      });

      socket.on('participantsUpdate', (data: { count: number; participants: LiveParticipant[] }) => {
        setOnlineCount(data.count);
        setParticipants(data.participants);
      });

      socket.on('liveEnded', () => {
        setLiveClass((prev) =>
          prev ? { ...prev, status: LiveClassStatus.ENDED, currentParticipants: 0 } : prev,
        );
        setJoined(false);
        setOnlineCount(0);
        setParticipants([]);
        setJoinError({ code: JoinLiveErrorCode.ENDED, message: '直播已结束' });
      });

      socket.on('message', (msg: ChatMessage) => {
        setMessages((prev) => [...prev, msg]);
      });

      socket.on('userJoined', (data: any) => {
        pushSystemMessage(`${data.userName || '某用户'} 进入了直播间`);
      });

      socket.on('userLeft', (data: any) => {
        pushSystemMessage(`${data.userName || '某用户'} 离开了直播间`);
      });

      socket.on('handRaised', (data: any) => {
        pushSystemMessage(`${data.userName} 举手了`);
      });

      socket.on('handLowered', (data: any) => {
        pushSystemMessage(`${data.userName || '某用户'} 放下了手`);
      });
    },
    [],
  );

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setJoinError(null);
      try {
        const data = await liveClassApi.get(id);
        if (cancelled) return;
        if (data.id !== id) {
          // 课程目录带过来的是课时 ID，跳转到直播课堂本身
          navigate(`/live/${data.id}`, { replace: true });
          return;
        }
        setLiveClass(data);
        setOnlineCount(data.currentParticipants);
        initSocket(data.id);
      } catch {
        if (!cancelled) {
          setJoinError({ code: JoinLiveErrorCode.NOT_FOUND, message: '直播课堂不存在' });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();

    return () => {
      cancelled = true;
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, [id, navigate, initSocket]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const sendMessage = () => {
    if (!inputMessage.trim() || !socketRef.current || !joined) return;
    socketRef.current.emit('sendMessage', {
      roomId: id,
      message: inputMessage,
    });
    setInputMessage('');
  };

  const toggleHand = () => {
    if (!socketRef.current || !joined) return;
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
        return <Tag color="gray">已结束</Tag>;
    }
  };

  const renderJoinError = () => {
    if (!joinError) return null;

    const config: Record<JoinLiveErrorCode, { status: 'warning' | 'info' | '404' | '403'; extra?: React.ReactNode }> = {
      [JoinLiveErrorCode.NOT_ENROLLED]: {
        status: 'warning',
        extra: liveClass?.courseId && (
          <Button type="primary" onClick={() => navigate(`/courses/${liveClass.courseId}`)}>
            前往课程页报名
          </Button>
        ),
      },
      [JoinLiveErrorCode.NOT_STARTED]: {
        status: 'info',
        extra: <Text type="secondary">正在等待开播，开播后将自动进入…</Text>,
      },
      [JoinLiveErrorCode.FULL]: {
        status: 'warning',
        extra: <Text type="secondary">正在等待空位，有名额后将自动进入…</Text>,
      },
      [JoinLiveErrorCode.ENDED]: { status: 'info' },
      [JoinLiveErrorCode.NOT_FOUND]: { status: '404' },
      [JoinLiveErrorCode.UNAUTHORIZED]: {
        status: 'warning',
        extra: (
          <Button type="primary" onClick={() => navigate('/login')}>
            重新登录
          </Button>
        ),
      },
    };

    const { status, extra } = config[joinError.code] || { status: 'warning' as const };

    return (
      <Card>
        <Result
          status={status}
          title={joinError.message}
          extra={
            <Space direction="vertical">
              {extra}
              <Button icon={<ArrowLeftOutlined />} onClick={() => navigate(-1)}>
                返回
              </Button>
            </Space>
          }
        />
      </Card>
    );
  };

  if (loading) {
    return <Card><div style={{ textAlign: 'center', padding: 50 }}>加载中...</div></Card>;
  }

  if (joinError) {
    return renderJoinError();
  }

  if (!joined) {
    return <Card><div style={{ textAlign: 'center', padding: 50 }}>正在进入课堂...</div></Card>;
  }

  const isLive = liveClass?.status === LiveClassStatus.LIVE;

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
        <Tag icon={<TeamOutlined />} color="blue">
          在线 {onlineCount}/{liveClass?.maxParticipants ?? '-'} 人
        </Tag>
      </Space>

      <div className="live-container">
        <div className="live-video-area">
          <div style={{ textAlign: 'center' }}>
            <Title level={2} style={{ color: 'white' }}>直播区域</Title>
            <Text style={{ color: 'white', opacity: 0.7 }}>
              {isLive ? '直播进行中...' : '等待直播开始...'}
            </Text>
            <div style={{ marginTop: 24 }}>
              <Space>
                {isTeacher && liveClass?.status === LiveClassStatus.SCHEDULED && (
                  <Button type="primary" size="large" onClick={startLive}>
                    开始直播
                  </Button>
                )}
                {isTeacher && isLive && (
                  <Button type="primary" danger size="large" onClick={endLive}>
                    结束直播
                  </Button>
                )}
                {!isTeacher && isLive && !checkedIn && (
                  <Button type="primary" size="large" icon={<CheckCircleOutlined />} onClick={handleCheckIn}>
                    签到
                  </Button>
                )}
              </Space>
            </div>
          </div>
        </div>

        <div className="live-sidebar">
          {myRole === 'teacher' && (
            <Card
              title={`在线名单（${onlineCount} 人）`}
              size="small"
              style={{ maxHeight: 260, overflow: 'auto' }}
            >
              <List
                size="small"
                dataSource={participants}
                locale={{ emptyText: '暂无学生在线' }}
                renderItem={(p) => (
                  <List.Item style={{ padding: '6px 0' }}>
                    <Space>
                      <Avatar size="small" style={{ background: p.role === 'teacher' ? '#faad14' : '#1890ff' }}>
                        {p.name?.[0]}
                      </Avatar>
                      <Text>{p.name}</Text>
                      {p.role === 'teacher' && <Tag color="gold">教师</Tag>}
                    </Space>
                  </List.Item>
                )}
              />
            </Card>
          )}
          <Card title="互动聊天" size="small" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
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
                  disabled={!joined}
                />
                <Button type="primary" onClick={sendMessage} disabled={!joined}>
                  发送
                </Button>
              </Space.Compact>
              <div style={{ marginTop: 12 }}>
                <Space>
                  <Button
                    type={handRaised ? 'primary' : 'default'}
                    icon={<LikeOutlined />}
                    onClick={toggleHand}
                    disabled={!isLive || !joined}
                  >
                    {handRaised ? '放下手' : '举手'}
                  </Button>
                </Space>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
