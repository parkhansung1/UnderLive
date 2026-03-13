# 1. 도커허브에서 Nginx 초기 패키지를 가져옵니다.
FROM nginx:latest 

# 2. 내가 만든 index.html을 Nginx의 웹 경로로 복사합니다.
COPY firstcompany/src/index.html /usr/share/nginx/html/index.html

# 3. 80번 포트를 열어줍니다.
EXPOSE 80
