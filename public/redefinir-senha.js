const form = document.querySelector("#passwordResetForm");
const statusBox = document.querySelector("#passwordResetStatus");
const token = new URLSearchParams(location.search).get("token") || "";

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!token) {
    statusBox.textContent = "Link inválido. Solicite uma nova recuperação.";
    return;
  }
  const password = form.elements.password.value;
  if (password !== form.elements.confirmPassword.value) {
    statusBox.textContent = "As senhas não conferem.";
    return;
  }
  statusBox.textContent = "Salvando nova senha...";
  const response = await fetch("/api/customer/password-reset/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, password })
  });
  const data = await response.json();
  if (!response.ok) {
    statusBox.textContent = data.error || "Não foi possível redefinir.";
    return;
  }
  statusBox.innerHTML = "Senha alterada. <a href=\"/conta.html\">Entrar na Minha Basa</a>";
});
