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

  // 处理上传文件的静态文件请求
  if (req.url.startsWith("/uploads/")) {
    const filePath = path.join(__dirname, req.url);
    if (fs.existsSync(filePath)) {
      const extname = String(path.extname(filePath)).toLowerCase();
      const mimeTypes = {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".zip": "application/zip",
        ".rar": "application/x-rar-compressed",
      };

      const contentType = mimeTypes[extname] || "application/octet-stream";

      res.writeHead(200, { "Content-Type": contentType });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
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

// 创建WebSocket服务器，增加消息大小限制
const wss = new WebSocket.Server({
  server,
  maxPayload: 1024 * 1024 * 1024, // 1GB
});

// 创建文件存储目录
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// 存储班级签到数据
const classData = {
  class1: { name: "班级1", students: [], files: [] },
  class2: { name: "班级2", students: [], files: [] },
  class3: { name: "班级3", students: [], files: [] },
};

// 存储正在上传的文件块
const uploadChunks = {};
const homeworkChunks = {};

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
            // 存储为包含ws属性的对象，而不是直接存储WebSocket对象
            clients.students.push({
              ws: ws,
              studentId: null,
              studentName: null,
              classId: null,
            });
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

            // 广播当前班级数据给所有教师，包括签到状态
            broadcastToTeachers({
              type: "init",
              classData: classData,
            });

            // 检查所有已连接的学生，广播他们的签到状态
            clients.students.forEach((client) => {
              if (client.studentId && client.classId) {
                const existingStudent = classData[client.classId].students.find(
                  (s) => s.id === client.studentId,
                );
                if (existingStudent) {
                  // 广播签到信息给所有老师
                  broadcastToTeachers({
                    type: "signin",
                    classId: client.classId,
                    student: existingStudent,
                  });
                }
              }
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

            // 如果是同一学生使用同一设备重新签到，允许通过
            if (existingStudent && existingStudent.deviceId === data.deviceId) {
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

              // 广播签到信息给所有老师（确保教师端同步更新）
              broadcastToTeachers({
                type: "signin",
                classId: data.classId,
                student: existingStudent,
              });

              // 向学生发送成功信息（恢复签到状态）
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "signinSuccess",
                    message: "欢迎回来！",
                  }),
                );
              }
            } else if (!existingStudent && !deviceIdUsed) {
              // 新学生签到
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
                  errorMessage = "您已经在其他设备上签到过了！";
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

            try {
              // 从Data URL中提取Base64数据
              const base64Data = data.fileUrl.split(",")[1];
              const buffer = Buffer.from(base64Data, "base64");

              // 创建班级文件夹
              const classDir = path.join(uploadDir, data.classId);
              if (!fs.existsSync(classDir)) {
                fs.mkdirSync(classDir, { recursive: true });
              }

              // 生成唯一文件名
              const fileName = `${Date.now()}_${data.fileName}`;
              const filePath = path.join(classDir, fileName);

              // 保存文件到磁盘
              fs.writeFileSync(filePath, buffer);
              console.log(`保存文件到磁盘: ${filePath}`);

              // 创建文件对象，存储相对路径
              const file = {
                id: Date.now() + Math.random().toString(36).substr(2, 9),
                name: data.fileName,
                size: data.fileSize,
                url: `/uploads/${data.classId}/${fileName}`,
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
            } catch (error) {
              console.error("文件上传失败:", error);
            }
          } else {
            console.error("文件上传失败: 权限不足或班级不存在");
          }
          break;

        case "uploadFileChunk":
          // 处理文件分块上传
          console.log("收到文件分块上传请求:", data);
          if (data.role === "teacher" && classData[data.classId]) {
            console.log(
              "处理教师文件分块上传，班级ID:",
              data.classId,
              "文件ID:",
              data.fileId,
            );

            try {
              // 初始化上传任务
              if (!uploadChunks[data.fileId]) {
                uploadChunks[data.fileId] = {
                  fileName: data.fileName,
                  fileSize: data.fileSize,
                  totalChunks: data.totalChunks,
                  chunks: {},
                  classId: data.classId,
                };
              }

              // 存储当前块
              const base64Data = data.chunkData.split(",")[1];
              const buffer = Buffer.from(base64Data, "base64");
              uploadChunks[data.fileId].chunks[data.chunkIndex] = buffer;

              console.log(
                `存储文件块: ${data.fileId}, 块索引: ${data.chunkIndex}, 总块数: ${data.totalChunks}`,
              );

              // 检查是否所有块都已上传
              if (
                Object.keys(uploadChunks[data.fileId].chunks).length ===
                data.totalChunks
              ) {
                console.log(`所有块上传完成，开始合并文件: ${data.fileName}`);

                // 创建班级文件夹
                const classDir = path.join(uploadDir, data.classId);
                if (!fs.existsSync(classDir)) {
                  fs.mkdirSync(classDir, { recursive: true });
                }

                // 处理文件路径，支持文件夹上传
                const originalFileName = data.fileName;
                const uniqueFileName = `${Date.now()}_${originalFileName.replace(/\//g, "_")}`;

                // 提取目录路径（如果有）
                const pathParts = originalFileName.split("/");
                let relativePath = "";
                let fileName = uniqueFileName;

                if (pathParts.length > 1) {
                  // 有目录结构，提取目录部分
                  relativePath = pathParts.slice(0, -1).join("/");
                  fileName = pathParts[pathParts.length - 1];
                }

                // 创建完整的目录结构
                let finalDir = classDir;
                if (relativePath) {
                  finalDir = path.join(classDir, relativePath);
                  if (!fs.existsSync(finalDir)) {
                    fs.mkdirSync(finalDir, { recursive: true });
                  }
                }

                // 生成最终文件路径
                const filePath = path.join(finalDir, fileName);

                // 合并块并保存文件
                const writeStream = fs.createWriteStream(filePath);
                for (let i = 0; i < data.totalChunks; i++) {
                  writeStream.write(uploadChunks[data.fileId].chunks[i]);
                }
                writeStream.end();

                // 当文件写入完成后
                writeStream.on("finish", () => {
                  console.log(`文件合并完成: ${filePath}`);

                  // 创建文件对象，存储相对路径
                  const file = {
                    id: Date.now() + Math.random().toString(36).substr(2, 9),
                    name: originalFileName,
                    size: data.fileSize,
                    url: `/uploads/${data.classId}/${relativePath ? relativePath + "/" : ""}${fileName}`,
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
                  broadcastToTeachers(fileUploadedMessage);
                  broadcastToStudents(fileUploadedMessage);
                  console.log("文件分块上传处理完成");

                  // 清理临时数据
                  delete uploadChunks[data.fileId];
                });
              }
            } catch (error) {
              console.error("文件分块上传失败:", error);
              // 清理临时数据
              if (uploadChunks[data.fileId]) {
                delete uploadChunks[data.fileId];
              }
            }
          } else {
            console.error("文件分块上传失败: 权限不足或班级不存在");
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

            try {
              // 从Data URL中提取Base64数据
              const base64Data = data.fileUrl.split(",")[1];
              const buffer = Buffer.from(base64Data, "base64");

              // 创建班级作业文件夹
              const classHomeworkDir = path.join(
                uploadDir,
                data.classId,
                "homeworks",
              );
              if (!fs.existsSync(classHomeworkDir)) {
                fs.mkdirSync(classHomeworkDir, { recursive: true });
              }

              // 生成唯一文件名
              const fileName = `${Date.now()}_${data.fileName}`;
              const filePath = path.join(classHomeworkDir, fileName);

              // 保存文件到磁盘
              fs.writeFileSync(filePath, buffer);
              console.log(`保存作业文件到磁盘: ${filePath}`);

              // 创建作业对象，存储相对路径
              const homework = {
                id: Date.now() + Math.random().toString(36).substr(2, 9),
                studentName: data.studentName,
                fileName: data.fileName,
                fileSize: data.fileSize,
                fileUrl: `/uploads/${data.classId}/homeworks/${fileName}`,
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
            } catch (error) {
              console.error("作业上传失败:", error);
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    type: "homeworkError",
                    message: "作业上传失败，请稍后再试",
                  }),
                );
              }
            }
          } else {
            console.error("作业上传失败: 权限不足或班级不存在");
          }
          break;

        case "uploadHomeworkChunk":
          // 处理作业分块上传
          console.log("收到作业分块上传请求:", data);
          if (data.role === "student" && classData[data.classId]) {
            console.log(
              "处理学生作业分块上传，班级ID:",
              data.classId,
              "文件ID:",
              data.fileId,
            );

            try {
              // 初始化上传任务
              if (!homeworkChunks[data.fileId]) {
                homeworkChunks[data.fileId] = {
                  studentName: data.studentName,
                  fileName: data.fileName,
                  fileSize: data.fileSize,
                  totalChunks: data.totalChunks,
                  chunks: {},
                  classId: data.classId,
                  ws: ws,
                };
              }

              // 存储当前块
              const base64Data = data.chunkData.split(",")[1];
              const buffer = Buffer.from(base64Data, "base64");
              homeworkChunks[data.fileId].chunks[data.chunkIndex] = buffer;

              console.log(
                `存储作业块: ${data.fileId}, 块索引: ${data.chunkIndex}, 总块数: ${data.totalChunks}`,
              );

              // 检查是否所有块都已上传
              if (
                Object.keys(homeworkChunks[data.fileId].chunks).length ===
                data.totalChunks
              ) {
                console.log(
                  `所有块上传完成，开始合并作业文件: ${data.fileName}`,
                );

                // 创建班级作业文件夹
                const classHomeworkDir = path.join(
                  uploadDir,
                  data.classId,
                  "homeworks",
                );
                if (!fs.existsSync(classHomeworkDir)) {
                  fs.mkdirSync(classHomeworkDir, { recursive: true });
                }

                // 生成唯一文件名
                const fileName = `${Date.now()}_${data.fileName}`;
                const filePath = path.join(classHomeworkDir, fileName);

                // 合并块并保存文件
                const writeStream = fs.createWriteStream(filePath);
                for (let i = 0; i < data.totalChunks; i++) {
                  writeStream.write(homeworkChunks[data.fileId].chunks[i]);
                }
                writeStream.end();

                // 当文件写入完成后
                writeStream.on("finish", () => {
                  console.log(`作业文件合并完成: ${filePath}`);

                  // 创建作业对象，存储相对路径
                  const homework = {
                    id: Date.now() + Math.random().toString(36).substr(2, 9),
                    studentName: data.studentName,
                    fileName: data.fileName,
                    fileSize: data.fileSize,
                    fileUrl: `/uploads/${data.classId}/homeworks/${fileName}`,
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
                  broadcastToTeachers(homeworkUploadedMessage);

                  // 发送作业上传成功消息给学生
                  if (
                    homeworkChunks[data.fileId].ws.readyState === WebSocket.OPEN
                  ) {
                    homeworkChunks[data.fileId].ws.send(
                      JSON.stringify({
                        type: "homeworkUploaded",
                        message: "作业上传成功",
                      }),
                    );
                  }
                  console.log("作业分块上传处理完成");

                  // 清理临时数据
                  delete homeworkChunks[data.fileId];
                });
              }
            } catch (error) {
              console.error("作业分块上传失败:", error);
              // 清理临时数据
              if (homeworkChunks[data.fileId]) {
                if (
                  homeworkChunks[data.fileId].ws.readyState === WebSocket.OPEN
                ) {
                  homeworkChunks[data.fileId].ws.send(
                    JSON.stringify({
                      type: "homeworkError",
                      message: "作业上传失败，请稍后再试",
                    }),
                  );
                }
                delete homeworkChunks[data.fileId];
              }
            }
          } else {
            console.error("作业分块上传失败: 权限不足或班级不存在");
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
              // 保存作业文件并按学生姓名分类
              const studentFolders = {};
              for (const homework of homeworks) {
                // 从磁盘读取作业文件
                const filePath = path.join(__dirname, homework.fileUrl);
                if (fs.existsSync(filePath)) {
                  // 创建以学生姓名命名的文件夹
                  const studentFolder = path.join(
                    classTempDir,
                    homework.studentName,
                  );
                  if (!fs.existsSync(studentFolder)) {
                    fs.mkdirSync(studentFolder, { recursive: true });
                    studentFolders[homework.studentName] = studentFolder;
                  }

                  // 复制文件到学生文件夹中
                  const destFilePath = path.join(
                    studentFolder,
                    homework.fileName,
                  );
                  fs.copyFileSync(filePath, destFilePath);
                  console.log(
                    `保存作业文件: ${homework.studentName}/${homework.fileName}`,
                  );
                } else {
                  console.error(`作业文件不存在: ${filePath}`);
                }
              }

              // 创建ZIP文件
              const zip = new AdmZip();
              const zipFileName = `homework_${data.classId}_${Date.now()}.zip`;
              const zipFilePath = path.join(tempDir, zipFileName);

              // 添加所有学生文件夹到ZIP
              Object.keys(studentFolders).forEach((studentName) => {
                const studentFolder = studentFolders[studentName];
                const files = fs.readdirSync(studentFolder);
                files.forEach((file) => {
                  const filePath = path.join(studentFolder, file);
                  zip.addLocalFile(filePath, studentName);
                });
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

        case "broadcastMessage":
          // 处理广播消息
          console.log("收到广播消息请求:", data);
          // 广播消息给所有学生
          clients.students.forEach((client) => {
            // 检查连接状态
            if (client.ws && client.ws.readyState === WebSocket.OPEN) {
              // 发送广播消息给所有学生
              client.ws.send(
                JSON.stringify({
                  type: "broadcastMessage",
                  message: data.message,
                }),
              );
            }
          });
          console.log("广播消息处理完成");
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
      const student = clients.students[studentIndex];
      clients.students.splice(studentIndex, 1);
      // 注意：不移除学生签到信息，保持签到状态，允许学生重新连接时恢复

      // 广播学生下线消息给所有教师
      broadcastToTeachers({
        type: "signout",
        classId: student.classId,
        studentId: student.studentId,
      });

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
      const student = clients.students[i];
      clients.students.splice(i, 1);
      // 注意：不移除学生签到信息，保持签到状态

      // 广播学生下线消息给所有教师
      if (student.classId && student.studentId) {
        broadcastToTeachers({
          type: "signout",
          classId: student.classId,
          studentId: student.studentId,
        });
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

const PORT = process.env.PORT || 3002;
server.listen(PORT, () => {
  console.log(`服务器运行在${PORT}端口`);
  console.log(`教师机访问: http://localhost:${PORT}`);
  console.log(`学生电脑访问: http://localhost:${PORT}/student.html`);
});
