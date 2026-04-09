const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const server = http.createServer((req, res) => {
  // 处理下载请求
  if (req.url.startsWith("/download/")) {
    const fileName = req.url.split("/").pop();
    const filePath = path.join(__dirname, "temp", fileName);

    if (fs.existsSync(filePath)) {
      // 设置响应头
      res.writeHead(200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Content-Length": fs.statSync(filePath).size,
      });

      // 发送文件
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);

      // 发送完成后删除文件
      stream.on("end", () => {
        setTimeout(() => {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
          }
        }, 5000);
      });
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("File not found", "utf-8");
    }
    return;
  }

  // 处理静态文件请求
  let filePath = "." + req.url;
  if (filePath === "./") {
    filePath = "./teacher.html";
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
  };

  const contentType = mimeTypes[extname] || "application/octet-stream";

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code == "ENOENT") {
        fs.readFile("./404.html", (error, content) => {
          res.writeHead(404, { "Content-Type": "text/html" });
          res.end(content, "utf-8");
        });
      } else {
        res.writeHead(500);
        res.end(
          "Sorry, check with the site admin for error: " + error.code + " ..\n",
        );
        res.end();
      }
    } else {
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content, "utf-8");
    }
  });
});

const wss = new WebSocket.Server({ server });

// 存储班级签到数据
const classData = {
  class1: { name: "班级1", students: [], files: [] },
  class2: { name: "班级2", students: [], files: [] },
  class3: { name: "班级3", students: [], files: [] },
};

// 存储学生名单数据
let studentData = {
  class1: [],
  class2: [],
  class3: [],
};

// 存储班级名称映射
let classNames = {
  class1: "班级1",
  class2: "班级2",
  class3: "班级3",
};

// 存储年级-班级映射
let gradeClassMap = {};

// 存储客户端连接
const clients = {
  teachers: [],
  students: [], // 每个元素格式: { ws: WebSocket, studentId: string, studentName: string, classId: string }
};

// 广播消息给所有老师
function broadcastToTeachers(message) {
  clients.teachers.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// 广播消息给所有学生
function broadcastToStudents(message) {
  clients.students.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// 广播学生连接数量给所有教师
function broadcastStudentCount() {
  const count = clients.students.length;
  broadcastToTeachers({
    type: "studentCount",
    count: count,
  });
}

wss.on("connection", (ws) => {
  // 设置心跳定时器和超时定时器
  let heartbeatInterval;
  let lastPongTime = Date.now();

  // 启动心跳检测
  function startHeartbeat() {
    // 每5秒发送一次心跳
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));

        // 检查客户端是否在30秒内回复了pong
        const now = Date.now();
        if (now - lastPongTime > 30000) {
          console.log("客户端心跳超时，关闭连接");
          ws.close();
        }
      } else {
        clearInterval(heartbeatInterval);
      }
    }, 5000);
  }

  // 处理消息
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "register":
          if (data.role === "teacher") {
            clients.teachers.push(ws);
            // 发送当前签到数据给老师
            ws.send(
              JSON.stringify({
                type: "init",
                classData: classData,
              }),
            );
            // 发送当前学生连接数量
            ws.send(
              JSON.stringify({
                type: "studentCount",
                count: clients.students.length,
              }),
            );
          } else if (data.role === "student") {
            clients.students.push(ws);
            // 发送学生名单数据给学生
            ws.send(
              JSON.stringify({
                type: "studentData",
                studentData: studentData,
                classNames: classNames,
                gradeClassMap: gradeClassMap,
              }),
            );
            // 广播学生连接数量给所有教师
            broadcastStudentCount();
          }
          // 启动心跳检测
          startHeartbeat();
          break;

        case "pong":
          // 收到客户端的心跳响应，更新最后回复时间
          lastPongTime = Date.now();
          break;

        case "uploadStudentData":
          // 处理教师上传学生名单
          if (data.role === "teacher") {
            studentData = data.studentData;
            // 更新班级名称映射
            if (data.classNames) {
              classNames = data.classNames;
            }
            // 更新年级-班级映射
            if (data.gradeClassMap) {
              gradeClassMap = data.gradeClassMap;
            }
            // 更新班级数据结构
            for (const classId in studentData) {
              if (!classData[classId]) {
                const className =
                  classNames[classId] || `班级${classId.replace("class", "")}`;
                classData[classId] = { name: className, students: [] };
              } else if (classNames[classId]) {
                classData[classId].name = classNames[classId];
              }
            }
            // 广播学生名单给所有学生
            broadcastToStudents({
              type: "studentData",
              studentData: studentData,
              classNames: classNames,
              gradeClassMap: gradeClassMap,
            });
          }
          break;

        case "signin":
          // 处理学生签到
          if (classData[data.classId]) {
            const existingStudent = classData[data.classId].students.find(
              (s) => s.id === data.studentId,
            );
            // 检查设备ID是否已被其他学生使用
            const deviceIdUsed = Object.values(classData).some((classInfo) =>
              classInfo.students.some(
                (s) => s.deviceId === data.deviceId && s.id !== data.studentId,
              ),
            );

            if (!existingStudent && !deviceIdUsed) {
              const student = {
                id: data.studentId,
                name: data.studentName,
                deviceId: data.deviceId || "",
                time: new Date().toLocaleString(),
              };
              classData[data.classId].students.push(student);

              // 更新客户端连接信息
              const clientIndex = clients.students.findIndex(
                (client) => client.ws === ws,
              );
              if (clientIndex !== -1) {
                clients.students[clientIndex] = {
                  ws: ws,
                  studentId: data.studentId,
                  studentName: data.studentName,
                  classId: data.classId,
                };
              }

              // 广播签到信息给所有老师
              broadcastToTeachers({
                type: "signin",
                classId: data.classId,
                student: student,
              });

              // 向学生发送成功信息
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "signinSuccess",
                    message: "签到成功！",
                  }),
                );
              }
            } else {
              // 向学生发送失败信息
              if (ws.readyState === WebSocket.OPEN) {
                let errorMessage = "";
                if (existingStudent) {
                  errorMessage = "您已经签到过了！";
                } else if (deviceIdUsed) {
                  errorMessage =
                    "当前设备已经签到过其他学生，请使用自己的电脑签到！";
                }
                ws.send(
                  JSON.stringify({
                    type: "signinError",
                    message: errorMessage,
                  }),
                );
              }
            }
          }
          break;

        case "clear":
          // 清空班级签到数据
          if (classData[data.classId]) {
            classData[data.classId].students = [];
            // 广播清空信息给所有老师
            broadcastToTeachers({
              type: "clear",
              classId: data.classId,
            });
          }
          break;

        case "chatMessage":
          // 处理聊天消息
          // 广播给所有老师
          broadcastToTeachers({
            type: "chatMessage",
            classId: data.classId,
            studentName: data.studentName,
            message: data.message,
          });
          // 广播给所有学生
          broadcastToStudents({
            type: "chatMessage",
            classId: data.classId,
            studentName: data.studentName,
            message: data.message,
          });
          break;

        case "enterChat":
          // 处理学生进入聊天室
          // 确保班级数据结构完整
          if (!classData[data.classId]) {
            classData[data.classId] = {
              name: `班级${data.classId.replace("class", "")}`,
              students: [],
              files: [],
              homeworks: [],
            };
          }
          if (!classData[data.classId].students) {
            classData[data.classId].students = [];
          }
          if (!classData[data.classId].files) {
            classData[data.classId].files = [];
          }
          if (!classData[data.classId].homeworks) {
            classData[data.classId].homeworks = [];
          }
          // 广播学生进入消息
          broadcastToTeachers({
            type: "chatMessage",
            classId: data.classId,
            studentName: "系统",
            message: `${data.studentName} 加入聊天室`,
          });
          broadcastToStudents({
            type: "chatMessage",
            classId: data.classId,
            studentName: "系统",
            message: `${data.studentName} 加入聊天室`,
          });
          // 广播聊天室成员消息
          broadcastToStudents({
            type: "chatMember",
            classId: data.classId,
            studentName: data.studentName,
          });
          // 发送文件列表给学生
          if (classData[data.classId]) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "fileList",
                  classId: data.classId,
                  files: classData[data.classId].files || [],
                }),
              );
            }
          }
          break;

        case "uploadFile":
          // 处理文件上传
          console.log("收到文件上传请求:", data);
          if (data.role === "teacher" && classData[data.classId]) {
            console.log("处理教师文件上传，班级ID:", data.classId);
            const file = {
              id: Date.now() + Math.random().toString(36).substr(2, 9),
              name: data.fileName,
              size: data.fileSize,
              url: data.fileUrl,
              uploadTime: new Date().toLocaleString(),
            };
            console.log("创建文件对象:", file);
            if (!classData[data.classId].files) {
              classData[data.classId].files = [];
            }
            classData[data.classId].files.push(file);
            console.log(
              "文件添加到班级:",
              data.classId,
              "当前文件数量:",
              classData[data.classId].files.length,
            );

            // 广播文件上传消息给所有教师和学生
            const fileUploadedMessage = {
              type: "fileUploaded",
              classId: data.classId,
              file: file,
            };
            console.log("广播文件上传消息:", fileUploadedMessage);
            console.log("教师数量:", clients.teachers.length);
            console.log("学生数量:", clients.students.length);
            broadcastToTeachers(fileUploadedMessage);
            broadcastToStudents(fileUploadedMessage);
            console.log("文件上传处理完成");
          } else {
            console.error("文件上传失败: 权限不足或班级不存在");
          }
          break;

        case "uploadHomework":
          // 处理作业上传
          console.log("收到作业上传请求:", data);
          if (data.role === "student" && classData[data.classId]) {
            console.log(
              "处理学生作业上传，班级ID:",
              data.classId,
              "学生姓名:",
              data.studentName,
            );
            const homework = {
              id: Date.now() + Math.random().toString(36).substr(2, 9),
              studentName: data.studentName,
              fileName: data.fileName,
              fileSize: data.fileSize,
              fileUrl: data.fileUrl,
              uploadTime: new Date().toLocaleString(),
            };
            console.log("创建作业对象:", homework);
            if (!classData[data.classId].homeworks) {
              classData[data.classId].homeworks = [];
            }
            classData[data.classId].homeworks.push(homework);
            console.log(
              "作业添加到班级:",
              data.classId,
              "当前作业数量:",
              classData[data.classId].homeworks.length,
            );

            // 广播作业上传消息给所有教师
            const homeworkUploadedMessage = {
              type: "homeworkUploaded",
              classId: data.classId,
              homework: homework,
            };
            console.log("广播作业上传消息:", homeworkUploadedMessage);
            console.log("教师数量:", clients.teachers.length);
            broadcastToTeachers(homeworkUploadedMessage);

            // 发送作业上传成功消息给学生
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "homeworkUploaded",
                  message: "作业上传成功",
                }),
              );
            }
            console.log("作业上传处理完成");
          } else {
            console.error("作业上传失败: 权限不足或班级不存在");
          }
          break;

        case "downloadHomework":
          // 处理下载作业请求
          console.log("收到下载作业请求:", data);
          if (classData[data.classId]) {
            console.log("处理下载作业请求，班级ID:", data.classId);
            const homeworks = classData[data.classId].homeworks || [];
            console.log("班级作业数量:", homeworks.length);

            if (homeworks.length === 0) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "homeworkError",
                    message: "该班级暂无作业",
                  }),
                );
              }
              console.log("下载作业请求处理完成: 无作业");
              break;
            }

            // 创建临时目录
            const tempDir = path.join(__dirname, "temp");
            const classTempDir = path.join(
              tempDir,
              `homework_${data.classId}_${Date.now()}`,
            );
            if (!fs.existsSync(tempDir)) {
              fs.mkdirSync(tempDir, { recursive: true });
            }
            if (!fs.existsSync(classTempDir)) {
              fs.mkdirSync(classTempDir, { recursive: true });
            }

            try {
              // 保存作业文件
              for (const homework of homeworks) {
                // 从Data URL中提取Base64数据
                const base64Data = homework.fileUrl.split(",")[1];
                const buffer = Buffer.from(base64Data, "base64");
                const filePath = path.join(classTempDir, homework.fileName);
                fs.writeFileSync(filePath, buffer);
                console.log(`保存作业文件: ${homework.fileName}`);
              }

              // 创建ZIP文件
              const zip = new AdmZip();
              const zipFileName = `homework_${data.classId}_${Date.now()}.zip`;
              const zipFilePath = path.join(tempDir, zipFileName);

              // 添加所有文件到ZIP
              const files = fs.readdirSync(classTempDir);
              files.forEach((file) => {
                const filePath = path.join(classTempDir, file);
                zip.addLocalFile(filePath, "");
              });

              // 生成ZIP文件
              zip.writeZip(zipFilePath);
              console.log(`生成ZIP文件: ${zipFileName}`);

              // 生成下载链接
              const downloadUrl = `/download/${zipFileName}`;

              // 发送下载链接给教师
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "homeworkDownload",
                    classId: data.classId,
                    downloadUrl: downloadUrl,
                    fileName: zipFileName,
                  }),
                );
              }

              console.log("下载作业请求处理完成");
            } catch (error) {
              console.error("打包作业失败:", error);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "homeworkError",
                    message: "打包作业失败，请稍后再试",
                  }),
                );
              }
            } finally {
              // 清理临时文件
              if (fs.existsSync(classTempDir)) {
                fs.rmSync(classTempDir, { recursive: true, force: true });
              }
            }
          } else {
            console.error("下载作业失败: 班级不存在");
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "homeworkError",
                  message: "班级不存在",
                }),
              );
            }
          }
          break;

        case "getFileList":
          // 处理获取文件列表请求
          if (classData[data.classId]) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "fileList",
                  classId: data.classId,
                  files: classData[data.classId].files || [],
                }),
              );
            }
          }
          break;
      }
    } catch (error) {
      console.error("Error parsing message:", error);
    }
  });

  // 处理连接关闭
  ws.on("close", () => {
    // 清除心跳定时器
    clearInterval(heartbeatInterval);
    // 从客户端列表中移除
    const teacherIndex = clients.teachers.findIndex((client) => client === ws);
    if (teacherIndex !== -1) {
      clients.teachers.splice(teacherIndex, 1);
    }

    const studentIndex = clients.students.findIndex(
      (client) => client.ws === ws,
    );
    if (studentIndex !== -1) {
      const studentInfo = clients.students[studentIndex];
      clients.students.splice(studentIndex, 1);

      // 移除学生签到信息
      if (studentInfo.classId && studentInfo.studentId) {
        const classInfo = classData[studentInfo.classId];
        if (classInfo) {
          const studentSigninIndex = classInfo.students.findIndex(
            (s) => s.id === studentInfo.studentId,
          );
          if (studentSigninIndex !== -1) {
            classInfo.students.splice(studentSigninIndex, 1);

            // 广播移除签到信息给所有老师
            broadcastToTeachers({
              type: "signout",
              classId: studentInfo.classId,
              studentId: studentInfo.studentId,
            });
          }
        }
      }

      // 广播学生连接数量
      broadcastStudentCount();
    }
  });

  // 处理连接错误
  ws.onerror = function (error) {
    console.error("WebSocket error:", error);
    clearInterval(heartbeatInterval);
  };
});

// 定期检查客户端连接状态
function checkClientConnections() {
  // 检查学生连接
  for (let i = clients.students.length - 1; i >= 0; i--) {
    const client = clients.students[i];
    // 检查连接状态，处理两种格式的学生对象
    const ws = client.ws || client;
    if (ws.readyState !== WebSocket.OPEN) {
      // 连接已关闭，移除学生
      const studentInfo = client;
      clients.students.splice(i, 1);

      // 移除学生签到信息
      if (studentInfo.classId && studentInfo.studentId) {
        const classInfo = classData[studentInfo.classId];
        if (classInfo) {
          const studentSigninIndex = classInfo.students.findIndex(
            (s) => s.id === studentInfo.studentId,
          );
          if (studentSigninIndex !== -1) {
            classInfo.students.splice(studentSigninIndex, 1);

            // 广播移除签到信息给所有老师
            broadcastToTeachers({
              type: "signout",
              classId: studentInfo.classId,
              studentId: studentInfo.studentId,
            });
          }
        }
      }

      // 广播学生连接数量
      broadcastStudentCount();
    }
  }

  // 检查老师连接
  for (let i = clients.teachers.length - 1; i >= 0; i--) {
    const client = clients.teachers[i];
    if (client.readyState !== WebSocket.OPEN) {
      // 连接已关闭，移除老师
      clients.teachers.splice(i, 1);
    }
  }
}

// 启动定期检查（每5秒检查一次）
setInterval(checkClientConnections, 5000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`服务器运行在${PORT}端口`);
  console.log(`教师机访问: http://localhost:${PORT}`);
  console.log(`学生电脑访问: http://localhost:${PORT}/student.html`);
});
