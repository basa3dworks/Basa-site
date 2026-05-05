const statusBox = document.querySelector("#verifyEmailStatus");
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";

async function verifyEmail() {
  if (!token) {
    statusBox.innerHTML = "<strong>Link inválido</strong><span>Abra o link completo enviado para seu e-mail.</span>";
    return;
  }
  const response = await fetch(`/api/customer/verify-email?token=${encodeURIComponent(token)}`);
  const data = await response.json();
  if (!response.ok) {
    statusBox.innerHTML = `<strong>Não foi possível confirmar</strong><span>${data.error || "Solicite um novo e-mail de confirmação."}</span><a class="secondary-link" href="/conta.html">Voltar para Minha Basa</a>`;
    return;
  }
  const session = JSON.parse(localStorage.getItem("basa_customer_session") || "null");
  if (session?.customer?.email && session.customer.email === data.account?.customer?.email) {
    session.emailVerified = true;
    localStorage.setItem("basa_customer_session", JSON.stringify(session));
  }
  statusBox.innerHTML = "<strong>E-mail confirmado</strong><span>Sua conta foi ativada com sucesso.</span><a class=\"secondary-link\" href=\"/conta.html\">Entrar na Minha Basa</a>";
}

verifyEmail();
