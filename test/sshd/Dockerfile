# SSH 터널 시험용 서버 (비밀번호 로그인 + TCP 전달만 허용)
FROM alpine:3
RUN apk add --no-cache openssh \
 && ssh-keygen -A \
 && adduser -D dboard \
 && echo 'dboard:dboard_test' | chpasswd \
 && sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding yes/; s/^#\?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
 && grep -q '^AllowTcpForwarding yes' /etc/ssh/sshd_config || echo 'AllowTcpForwarding yes' >> /etc/ssh/sshd_config
EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
