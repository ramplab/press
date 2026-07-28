"""Tiny model layer for anchor-resolution fixtures."""


class User:
    def __init__(self, name: str) -> None:
        self.name = name

    def display_name(self) -> str:
        return self.name.title()


def find_user(users, name):
    return next((u for u in users if u.name == name), None)
