from django.urls import path

from commerce import views

urlpatterns = [
    path("", views.public_page, {"page": "index.html"}),
    path("<str:page>.html", views.public_page),
    path("api/session", views.api_session),
    path("api/login", views.api_login),
    path("api/logout", views.api_logout),
    path("api/products", views.api_products),
    path("api/customer/access", views.api_customer_access),
    path("api/customer/orders", views.api_customer_orders),
    path("api/custom-requests", views.api_custom_requests),
    path("api/admin/dashboard", views.api_admin_dashboard),
    path("api/admin/products", views.api_admin_products),
    path("api/admin/products/<str:product_id>", views.api_admin_product_detail),
]
