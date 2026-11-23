# Entry point for a new Ren'Py visual novel.

define narrator = Character(None)
define guide = Character("Guide")

label start:
    scene black
    guide "Welcome to your Ren'Py project."
    narrator "Edit game/script.rpy to begin your story."
    menu:
        "Where should we go?"
        "Continue":
            guide "Your story starts here."
        "Finish":
            guide "See you soon."
    return
