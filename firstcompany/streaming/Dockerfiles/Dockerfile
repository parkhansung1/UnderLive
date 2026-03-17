FROM node:18
 
# 1. 패키지 업데이트 및 필요 도구 설치
# bcrypt는 네이티브 모듈이라 python3, make, g++ 필요
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*
 
WORKDIR /app
 
# 2. 의존성 파일 복사 및 설치
COPY firstcompany/streaming/src/package*.json ./
RUN npm install
 
# 3. 소스 코드 전체 복사 (html 폴더 포함)
COPY firstcompany/streaming/src/ .
 
# 4. 포트 설정 및 서버 실행
EXPOSE 3000
CMD ["node", "server.js"]

